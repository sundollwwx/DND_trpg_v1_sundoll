"""A resume hydrates private DM preparation but never publishes an old snapshot."""
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_state_publish_guard import StatePublishGuardTests
from server.host_state import HostStateConflict, merge_resume_record, resume_current, resume_ownership
from server.save_storage import campaign_text_hash


def fixture():
    token = dict(id='hero', type='pc', x=25, y=25, hp=20, hpMax=20,
                 gmNote='private preparation', conditions=[dict(id='secret', visibility='gm')])
    hidden = dict(id='hidden', type='npc', x=75, y=75, hp=90, hiddenFromPlayers=True, gmNote='ambush')
    formal = dict(campaignId='campaign', privateNotes='private module', state=dict(
        campaignId='campaign', activeMapId='private-map', presentedMapId='map',
        maps=[dict(id='map', name='Public map', mapData='full-resolution-source', gridSize=50,
                   playerAccessible=False, tokens=[token, hidden], doodles=[]),
              dict(id='private-map', name='Private preparation', mapData='private-source', playerAccessible=False, tokens=[])],
        parkedOwnedPieces={}, prepHandbook=[dict(text='DM only')], travelBasketOpen=False,
        journal=dict(revision=1, entries=[dict(id='old', text='old log')]),
        encounter=dict(round=1, turnSerial=1, allowInitiativeSwap=True, currentEntryId='secret-entry',
            entries=[dict(id='visible-entry', tokenId='hero', name='private alias', value=20, order=0),
                     dict(id='secret-entry', tokenId='hidden', name='hidden enemy', value=10, order=1)],
            worldTime=dict(totalSeconds=10, resumeAfterTurn=True),
            turnPath=dict(tokenId='hidden', mapId='map', points=[dict(x=75, y=75)]),
            lastEvent=dict(at=1, label='private event'))))
    live = dict(campaignId='campaign', activeMapId='map', mapPresentationId='presentation-7',
        maps=[dict(id='map', name='Public map', mapData=None, playerAccessible=True,
                   gridSize=50, tokens=[dict(id='hero', type='pc', x=125, y=175, hp=3, hpMax=20,
                   conditions=[dict(id='poison', visibility='public')])], doodles=[dict(id='stroke')]),
              dict(id='private-map', name=None, mapData=None, playerAccessible=False, tokens=[], doodles=[])],
        parkedOwnedPieces={}, travelBasketOpen=True,
        journal=dict(revision=2, entries=[dict(id='new', text='latest log')]),
        sharedResources=[dict(name='Shared page', url='https://example.com')],
        encounter=dict(round=1, turnSerial=1, allowInitiativeSwap=False, currentEntryId=None,
            entries=[dict(id='visible-entry', tokenId='hero', name='public label', value=22, order=0)],
            worldTime=dict(totalSeconds=35, runningSince=None, rate=1),
            turnPath=dict(tokenId=None, mapId=None, points=[]), lastEvent=dict(at=1, label='redacted')))
    return formal, live


class ResumeMergeTests(unittest.TestCase):
    def test_current_values_and_private_preparation_survive_without_mutating_inputs(self):
        formal, live = fixture(); before = copy.deepcopy((formal, live))
        merged = merge_resume_record(formal, live); state = merged['state']
        tokens = {t['id']: t for t in state['maps'][0]['tokens']}
        self.assertEqual((tokens['hero']['hp'], tokens['hero']['x']), (3, 125))
        self.assertEqual(tokens['hero']['gmNote'], 'private preparation')
        self.assertEqual([c['id'] for c in tokens['hero']['conditions']], ['secret', 'poison'])
        self.assertEqual(tokens['hidden'], formal['state']['maps'][0]['tokens'][1])
        self.assertEqual(state['maps'][0]['mapData'], 'full-resolution-source')
        self.assertFalse(state['maps'][0]['playerAccessible'])
        self.assertEqual(state['maps'][1], formal['state']['maps'][1])
        self.assertEqual(state['maps'][0]['doodles'], live['maps'][0]['doodles'])
        self.assertEqual(state['journal'], live['journal'])
        self.assertEqual(state['prepHandbook'], formal['state']['prepHandbook'])
        self.assertEqual(merged['privateNotes'], formal['privateNotes'])
        self.assertEqual((state['activeMapId'], state['presentedMapId']), ('private-map', 'map'))
        self.assertTrue(state['travelBasketOpen'])
        encounter = state['encounter']
        self.assertTrue(encounter['allowInitiativeSwap'])
        self.assertEqual(encounter['currentEntryId'], 'secret-entry')
        self.assertEqual(encounter['worldTime']['totalSeconds'], 35)
        self.assertTrue(encounter['worldTime']['resumeAfterTurn'])
        self.assertEqual(encounter['turnPath'], formal['state']['encounter']['turnPath'])
        self.assertEqual(encounter['lastEvent']['label'], 'private event')
        self.assertEqual(len(encounter['entries']), 2)
        self.assertEqual((formal, live), before)

    def test_owned_movement_and_parking_keep_private_fields_and_central_transfer(self):
        formal, live = fixture()
        hero = formal['state']['maps'][0]['tokens'][0]
        hero.update(ownedPieceId='owned', ownerPlayerId='legacy-owner')
        current = live['maps'][0]['tokens'].pop(); current.update(ownedPieceId='owned', ownerPlayerId='current-owner')
        live['_ownedPieceLocations'] = [dict(mapId='private-map', token=current)]
        merged = merge_resume_record(formal, live, owners={'owned':'current-owner'})['state']
        self.assertEqual([t['id'] for t in merged['maps'][0]['tokens']], ['hidden'])
        moved = merged['maps'][1]['tokens'][0]
        self.assertEqual((moved['hp'], moved['ownerPlayerId'], moved['gmNote']), (3, 'current-owner', 'private preparation'))
        live['_ownedPieceLocations'] = []; live['parkedOwnedPieces'] = {'owned': dict(current, travelBasketStored=True)}
        parked = merge_resume_record(formal, live, owners={'owned':'current-owner'})['state']
        self.assertEqual(parked['parkedOwnedPieces']['owned']['hp'], 3)
        self.assertEqual(sum(len(m['tokens']) for m in parked['maps']), 1)
        with self.assertRaises(HostStateConflict): merge_resume_record(formal, live, owners={'owned':'other-owner'})
        with self.assertRaises(HostStateConflict): merge_resume_record(formal, live)

    def test_unclaimed_parked_legacy_is_preserved_without_new_ownership_or_changes(self):
        formal, live = fixture()
        original = dict(id='retired', ownedPieceId='unclaimed', ownerPlayerId='legacy', hp=4, gmNote='archive')
        formal['state']['parkedOwnedPieces'] = {'unclaimed':original}
        live['parkedOwnedPieces'] = {'unclaimed':dict(id='retired', ownedPieceId='unclaimed', ownerPlayerId='legacy', hp=4, travelBasketStored=False)}
        result = merge_resume_record(formal, live, owners={})
        self.assertEqual(result['state']['parkedOwnedPieces']['unclaimed'], original)
        live['parkedOwnedPieces']['unclaimed']['hp'] = 5
        with self.assertRaises(HostStateConflict): merge_resume_record(formal, live, owners={})

    def test_authoritative_character_conditions_use_same_revision_without_reviving_old_gm(self):
        formal, live = fixture()
        formal['state']['maps'][0]['tokens'][0].update(ownedPieceId='owned', ownerPlayerId='owner', characterRevision=3)
        current = live['maps'][0]['tokens'][0]
        current.update(ownedPieceId='owned', ownerPlayerId='owner', characterRevision=4,
                       conditions=[dict(id='new-private', visibility='gm'), dict(id='poison', visibility='public')])
        merged = merge_resume_record(formal, live, owners={'owned':'owner'})['state']
        hero = next(t for t in merged['maps'][0]['tokens'] if t['id']=='hero')
        self.assertEqual(hero['characterRevision'], 4)
        self.assertEqual(hero['conditions'], current['conditions'])
        self.assertEqual(hero['gmNote'], 'private preparation')

    def test_confirmed_recall_does_not_restore_old_initiative_entry(self):
        formal, live = fixture()
        hero = formal['state']['maps'][0]['tokens'][0]
        hero.update(ownedPieceId='owned', ownerPlayerId='owner')
        formal['state']['encounter']['currentEntryId'] = 'visible-entry'
        current = live['maps'][0]['tokens'].pop(); current.update(ownedPieceId='owned', ownerPlayerId='owner')
        live['parkedOwnedPieces'] = {'owned':current}
        live['encounter'].update(entries=[], currentEntryId=None, turnSerial=2, playMode='prepare')
        merged = merge_resume_record(formal, live, owners={'owned':'owner'})['state']
        self.assertEqual([e['id'] for e in merged['encounter']['entries']], ['secret-entry'])
        self.assertIsNone(merged['encounter']['currentEntryId'])
        self.assertEqual(merged['encounter']['turnSerial'], 2)

    def test_ambiguous_absence_rejected_but_hidden_covered_and_explicit_delete_proven(self):
        formal, live = fixture(); live['maps'][0]['tokens'] = []
        with self.assertRaises(HostStateConflict): merge_resume_record(formal, live)
        live['maps'][0]['gridCover'] = dict(all=True, cells={})
        result = merge_resume_record(formal, live)
        self.assertEqual(len(result['state']['maps'][0]['tokens']), 2)
        live['maps'][0].pop('gridCover')
        hero = formal['state']['maps'][0]['tokens'][0]; hero.update(id='pt-temp', playerCreated=True)
        result = merge_resume_record(formal, live, [dict(op='deletePlayerToken', tokenId='pt-temp', campaignId='campaign')])
        self.assertEqual([t['id'] for t in result['state']['maps'][0]['tokens']], ['hidden'])

    def test_ambiguous_new_map_new_dm_token_and_hidden_turn_are_rejected(self):
        for mutate in (
            lambda live: live['maps'].append(dict(id='unknown',tokens=[])),
            lambda live: live['maps'][0]['tokens'].append(dict(id='new-npc',type='npc')),
            lambda live: live['encounter'].update(turnSerial=2),
            lambda live: live.update(campaignId='other'),
            lambda live: live['journal'].update(revision=0),
            lambda live: live['maps'][0].update(mapData='unproven-replacement-or-thumbnail'),
        ):
            formal, live = fixture(); mutate(live)
            with self.assertRaises(HostStateConflict): merge_resume_record(formal, live)

    def test_source_binding_and_receipt_do_not_write_or_manufacture_a_formal_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); target = root/'战役/campaign/当前存档.json'; target.parent.mkdir(parents=True)
            formal, live = fixture(); target.write_text(json.dumps(formal)); raw = target.read_bytes()
            digest = campaign_text_hash(raw); live['_formalSourceHash'] = digest
            data = dict(campaignId='campaign', path='战役/campaign/当前存档.json', expectedHash=digest)
            before = (target.stat().st_mtime_ns, raw, list(root.rglob('*')))
            result = resume_current(data, root, live, 12, 'session', stream_seq=8)
            self.assertEqual((result['stateRevision'], result['sessionId'], result['streamSeq']), (12, 'session', 8))
            self.assertEqual(result['sourceHash'], digest)
            self.assertNotEqual(campaign_text_hash(json.dumps(result['record']).encode()), digest)
            self.assertEqual(result['mapPresentationId'], 'presentation-7')
            self.assertEqual((target.stat().st_mtime_ns, target.read_bytes(), list(root.rglob('*'))), before)
            live['_formalSourceHash'] = '0'*64
            with self.assertRaises(HostStateConflict): resume_current(data, root, live, 12, 'session')
            live['_formalSourceHash'] = digest; data['expectedHash'] = '0'*64
            with self.assertRaises(HostStateConflict): resume_current(data, root, live, 12, 'session')

    def test_central_ownership_snapshot_is_room_scoped_and_does_not_write_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); file = root/'角色.sqlite3'
            db = sqlite3.connect(file)
            db.executescript('CREATE TABLE characters(id TEXT,carrier TEXT,account_id TEXT);CREATE TABLE carriers(id TEXT,account_id TEXT,enabled INT);CREATE TABLE room_characters(room TEXT,character_id TEXT);')
            db.executemany('INSERT INTO carriers VALUES (?,?,?)',[('p','a',1),('disabled','b',0)])
            db.executemany('INSERT INTO characters VALUES (?,?,?)',[('owned','p','a'),('other','p','a'),('blocked','disabled','b'),('mismatch','p','b')])
            db.executemany('INSERT INTO room_characters VALUES (?,?)',[('room','owned'),('other-room','other'),('room','blocked'),('room','mismatch')]);db.commit();db.close()
            before = (file.read_bytes(), file.stat().st_mtime_ns, set(root.iterdir()))
            with patch('server.account_characters.context', return_value=(root,'room')):
                self.assertEqual(resume_ownership(root), {'owned':'p'})
            self.assertEqual((file.read_bytes(), file.stat().st_mtime_ns, set(root.iterdir())), before)


class ResumeHttpTests(StatePublishGuardTests):
    def setup_live(self):
        self.baseline()  # Start the isolated worker before authoring its fixture.
        formal, live = fixture()
        formal['campaignId'] = formal['state']['campaignId'] = live['campaignId'] = self.room['id']
        root = self.accounts._supervisor.root/self.room['id']
        target = root/'战役包'/self.room['id']/'当前存档.json'
        target.write_text(json.dumps(formal))
        payload = self.state(**{k:v for k,v in live.items() if k != 'campaignId'})
        self.api('/api/state', payload)
        return target, dict(campaignId=self.room['id'], path='战役/'+self.room['id']+'/当前存档.json',
            expectedHash=campaign_text_hash(target.read_bytes()), **self.baseline())

    def test_resume_is_read_only_keeps_private_data_and_concurrent_dm_wins_cas(self):
        self.add_dm(); target, payload = self.setup_live()
        before = (self.checkpoint(), target.read_bytes(), target.stat().st_mtime_ns)
        receipt = self.api('/api/host-state/resume', payload, user=1)
        self.assertEqual(receipt['stateRevision'], payload['expectedStateRevision'])
        self.assertEqual(receipt['sourceHash'], payload['expectedHash'])
        self.assertEqual((self.checkpoint(), target.read_bytes(), target.stat().st_mtime_ns), before)
        tokens = {t['id']:t for t in receipt['record']['state']['maps'][0]['tokens']}
        self.assertEqual((tokens['hero']['hp'], tokens['hidden']['gmNote']), (3,'ambush'))
        latest = self.state('newer DM', **{k:v for k,v in self.api('/api/state').items() if not k.startswith('_') and k != 'campaignName'})
        self.api('/api/state', latest)
        rejected = self.api('/api/host-state/resume', payload, user=1, status=409)
        self.assertEqual(rejected['errorCode'], 'state-conflict')
        rejected = self.api('/api/state', dict(latest,expectedStateRevision=receipt['stateRevision'],serverSessionId=receipt['sessionId']),user=1,status=409)
        self.assertEqual(rejected['errorCode'], 'state-conflict')

    def test_bad_hash_session_identity_and_player_permissions_cannot_resume(self):
        invitation=self.rooms.invite(self.tokens[0],self.room['id'],'u1@example.com','player');self.rooms.accept(self.tokens[1],invitation)
        target, payload = self.setup_live(); before=(self.checkpoint(),target.read_bytes())
        for mutation in (dict(expectedHash='0'*64),dict(serverSessionId='old-session'),dict(campaignId='other')):
            self.api('/api/host-state/resume',dict(payload,**mutation),status=409)
            self.assertEqual((self.checkpoint(),target.read_bytes()),before)
        self.api('/api/host-state/resume',payload,user=1,status=403)
        self.api('/api/host-state/resume',payload,user=2,status=404)
        self.api('/api/host-state/resume',payload,headers={'X-Sundoll-Expected-Account':'different-account'},status=409)
        self.assertEqual((self.checkpoint(),target.read_bytes()),before)


def load_tests(loader, tests, pattern):
    suite=unittest.TestSuite()
    for cls in (ResumeMergeTests,ResumeHttpTests):
        for name in sorted(cls.__dict__):
            if name.startswith('test_'):suite.addTest(cls(name))
    return suite


if __name__ == '__main__': unittest.main()
