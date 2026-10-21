"""Real room workers: frozen DM baselines and formal-write receipts."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from test_campaign_rooms import CampaignRoomHttpTests, SERVER
from server.save_storage import campaign_text_hash, campaign_save_signature


class StatePublishGuardTests(CampaignRoomHttpTests):
    def api(self, suffix, data=None, user=0, status=200, **kwargs):
        code, body, _ = self.request('/rooms/' + self.room['id'] + suffix, data, user=user, **kwargs)
        self.assertEqual(code, status, body)
        return json.loads(body)

    def baseline(self, user=0):
        info = self.api('/api/info', user=user)
        return dict(expectedStateRevision=info['stateRevision'], serverSessionId=info['sessionId'])

    def state(self, name='first', **extra):
        rid = self.room['id']
        state = dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION, campaignId=rid,
                     campaignName=name, maps=[], _formalSourceHash=self.formal_source_hash(rid, rid))
        state.update(extra)
        return state

    def checkpoint(self):
        return (self.accounts._supervisor.root / self.room['id'] / '运行数据/房间运行状态.json').read_bytes()

    def add_dm(self):
        invitation = self.rooms.invite(self.tokens[0], self.room['id'], 'u1@example.com', 'dm')
        self.rooms.accept(self.tokens[1], invitation)

    def test_other_dm_cannot_replace_live_state_or_formal_file_with_old_baseline(self):
        self.add_dm()
        guard = self.baseline()
        first = self.state('DM A current')
        result = self.api('/api/state', dict(first, **guard))
        self.assertEqual(result['stateRevision'], guard['expectedStateRevision'] + 1)
        self.assertEqual(result['sessionId'], guard['serverSessionId'])
        previous = self.checkpoint()
        stale = dict(self.state('DM B stale'), **guard)
        retained = copy.deepcopy(stale)
        rejected = self.api('/api/state', stale, user=1, status=409)
        self.assertEqual(rejected['errorCode'], 'state-conflict')
        self.assertEqual(stale, retained)
        self.assertEqual(self.checkpoint(), previous)
        self.assertEqual(self.api('/api/state')['campaignName'], 'DM A current')
        rel = '战役/' + self.room['id'] + '/当前存档.json'
        read = self.api('/api/local-save', dict(op='read-campaign', path=rel))
        rejected = self.api('/api/local-save', dict(op='write-campaign', path=rel,
            protocolVersion=SERVER.SERVER_PROTOCOL_VERSION, expectedHash=read['sourceHash'],
            text=json.dumps(dict(campaignId=self.room['id'], state=self.state('old formal'))), **guard),
            user=1, status=409)
        self.assertEqual(rejected['errorCode'], 'state-conflict')
        self.assertEqual(self.api('/api/local-save', dict(op='read-campaign', path=rel))['sourceHash'], read['sourceHash'])
        self.assertEqual(self.checkpoint(), previous)

    def test_room_requires_well_typed_pair_and_does_not_persist_transport_guards(self):
        first = self.state()
        guard = self.baseline()
        rejected = self.api('/api/state', first, status=409, state_guard=False)
        self.assertEqual(rejected['errorCode'], 'state-version-required')
        for fields in (dict(expectedStateRevision=True, serverSessionId=guard['serverSessionId']),
                       dict(expectedStateRevision=-1, serverSessionId=guard['serverSessionId']),
                       dict(expectedStateRevision=0), dict(serverSessionId=guard['serverSessionId'])):
            with self.subTest(fields=fields):
                rejected = self.api('/api/state', dict(first, **fields), status=400)
                self.assertEqual(rejected['errorCode'], 'state-version-invalid')
        self.api('/api/state', dict(first, **guard))
        checkpoint = json.loads(self.checkpoint())['state']
        self.assertNotIn('expectedStateRevision', checkpoint)
        self.assertNotIn('serverSessionId', checkpoint)

    def test_restart_session_invalidates_same_revision_baseline(self):
        first = self.state()
        self.api('/api/state', first)
        guard = self.baseline()
        process = self.accounts._supervisor.workers[self.room['id']]['process']
        process.kill(); process.wait(timeout=5)
        info = self.api('/api/info')
        self.assertEqual(info['stateRevision'], guard['expectedStateRevision'])
        self.assertNotEqual(info['sessionId'], guard['serverSessionId'])
        previous = self.checkpoint()
        rejected = self.api('/api/state', dict(first, **guard), status=409)
        self.assertEqual(rejected['errorCode'], 'state-session-changed')
        self.assertEqual(self.checkpoint(), previous)

    def test_player_action_advances_revision_and_stale_dm_keeps_player_change(self):
        rid = self.room['id']
        self.make_character(0, rid)
        player = self.api('/api/account/player-session', {})['session']
        first = self.state(maps=[dict(id='m', mapW=500, mapH=500, playerAccessible=True,
                                    tokens=[dict(id='t', type='pc', ownerPlayerId=player['playerId'], hp=20, hpMax=20)])])
        self.api('/api/state', first)
        guard = self.baseline()
        self.api('/api/action', dict(sessionToken=player['sessionToken'], campaignId=rid,
            serverSessionId=guard['serverSessionId'], actionId='player-new-hp',
            action=dict(op='patchToken', mapId='m', tokenId='t', patch=dict(hp=6))))
        previous = self.checkpoint()
        rejected = self.api('/api/state', dict(first, **guard), status=409)
        self.assertEqual(rejected['errorCode'], 'state-conflict')
        self.assertEqual(self.api('/api/state')['maps'][0]['tokens'][0]['hp'], 6)
        self.assertEqual(self.checkpoint(), previous)

    def test_authority_is_host_only_and_exact_receipt_is_read_only(self):
        invitation = self.rooms.invite(self.tokens[0], self.room['id'], 'u1@example.com', 'player')
        self.rooms.accept(self.tokens[1], invitation)
        self.assertNotIn('stateAuthority', self.api('/api/info', user=1))
        self.assertFalse(self.api('/api/info')['stateAuthority']['published'])
        state = self.state()
        self.api('/api/state', state)
        self.assertTrue(self.api('/api/info')['stateAuthority']['published'])
        rel = '战役/' + self.room['id'] + '/当前存档.json'
        read = self.api('/api/local-save', dict(op='read-campaign', path=rel))
        text = json.dumps(dict(campaignId=self.room['id'], state=state))
        guard = self.baseline()
        saved = self.api('/api/local-save', dict(op='write-campaign', path=rel, text=text,
            expectedHash=read['sourceHash'], protocolVersion=SERVER.SERVER_PROTOCOL_VERSION, **guard))
        self.assertEqual(saved['stateRevision'], guard['expectedStateRevision'] + 1)
        file = self.accounts._supervisor.root / self.room['id'] / '战役包' / self.room['id'] / '当前存档.json'
        before = (file.read_bytes(), file.stat().st_mtime_ns, self.checkpoint())
        receipt = self.api('/api/local-save', dict(op='save-receipt', path=rel,
            signature=campaign_save_signature(read['sourceHash'], text)))
        self.assertTrue(receipt['committed']); self.assertTrue(receipt['matchesCurrent'])
        self.assertEqual(receipt['hash'], saved['hash'])
        self.assertEqual((receipt['stateRevision'], receipt['sessionId']),
                         (guard['expectedStateRevision'] + 1, guard['serverSessionId']))
        self.assertEqual(receipt['result']['stateRevision'], saved['stateRevision'])
        self.assertEqual(receipt['result']['sessionId'], saved['sessionId'])
        self.assertEqual((file.read_bytes(), file.stat().st_mtime_ns, self.checkpoint()), before)
        unknown = self.api('/api/local-save', dict(op='save-receipt', path=rel, signature='0'*64))
        self.assertFalse(unknown['committed'])
        self.api('/api/local-save', dict(op='save-receipt', path=rel, signature='bad'), status=400)
        self.api('/api/local-save', dict(op='save-receipt', path=rel, signature='0'*64), user=1, status=403)

    def test_crlf_formal_hash_matches_reader_publish_and_restart(self):
        state = self.state('CRLF current')
        path = self.accounts._supervisor.root / self.room['id'] / '战役包' / self.room['id'] / '当前存档.json'
        record = dict(campaignId=self.room['id'], state=dict(state))
        record['state'].pop('_formalSourceHash')
        raw = json.dumps(record, indent=2).replace('\n', '\r\n').encode()
        path.write_bytes(raw)
        read = self.api('/api/local-save', dict(op='read-campaign', path='战役/' + self.room['id'] + '/当前存档.json'))
        self.assertEqual(read['sourceHash'], campaign_text_hash(raw))
        state['_formalSourceHash'] = read['sourceHash']
        self.api('/api/state', state)
        process = self.accounts._supervisor.workers[self.room['id']]['process']
        process.kill(); process.wait(timeout=5)
        self.assertEqual(self.api('/api/state')['campaignName'], 'CRLF current')
        # A genuine content edit must still invalidate the old formal lineage.
        path.write_bytes(raw.replace(b'CRLF current', b'CRLF changed'))
        self.api('/api/state', state, status=409)

    def test_journal_event_carries_causal_revision_and_session(self):
        self.api('/api/state', self.state())
        guard = self.baseline()
        self.api('/api/journal', dict(campaignId=self.room['id'], revision=0, operation='create',
                                    entry=dict(title='Campaign note', text='Saved by current DM')))
        actions = self.api('/api/actions?after=0')['actions']
        self.assertEqual(actions[-1]['_stateRevision'], guard['expectedStateRevision'] + 1)
        self.assertEqual(actions[-1]['_sessionId'], guard['serverSessionId'])
        self.api('/api/state', dict(self.state(), **guard), status=409)


class OriginalWorkspaceGuardTests(unittest.TestCase):
    def test_legacy_first_publish_allowed_but_published_state_requires_baseline(self):
        handler = SERVER.Handler.__new__(SERVER.Handler)
        handler._send_json = mock.Mock()
        with mock.patch.object(SERVER, 'ROOM_RUNTIME', False, create=True), \
                mock.patch.object(SERVER, 'STATE', None), mock.patch.object(SERVER, 'STATE_REVISION', 0):
            self.assertTrue(handler._state_publish_guard(dict(maps=[])))
        for published in ({}, dict(campaignId='c', maps=[])):
            with mock.patch.object(SERVER, 'STATE', published):
                self.assertFalse(handler._state_publish_guard(dict(maps=[])))
                self.assertEqual(handler._send_json.call_args.args[0]['errorCode'], 'state-version-required')

    def test_nonroom_provided_guards_always_validate_session_and_revision(self):
        handler = SERVER.Handler.__new__(SERVER.Handler)
        handler._send_json = mock.Mock()
        with mock.patch.object(SERVER, 'STATE', None), mock.patch.object(SERVER, 'STATE_REVISION', 3):
            self.assertFalse(handler._state_publish_guard(dict(expectedStateRevision=2, serverSessionId=SERVER.SESSION_ID)))
            self.assertEqual(handler._send_json.call_args.args[0]['errorCode'], 'state-conflict')
            self.assertFalse(handler._state_publish_guard(dict(expectedStateRevision=3, serverSessionId='previous-process')))
            self.assertEqual(handler._send_json.call_args.args[0]['errorCode'], 'state-session-changed')
            self.assertTrue(handler._state_publish_guard(dict(expectedStateRevision=3, serverSessionId=SERVER.SESSION_ID)))

    def test_receipt_commits_with_formal_outbox_and_query_does_not_replay_failed_publication(self):
        from server import save_storage
        with tempfile.TemporaryDirectory() as root:
            rel = '战役/c/当前存档.json'
            text = json.dumps(dict(campaignId='c', state=dict(campaignId='c', maps=[])), indent=2).replace('\n', '\r\n')
            payload = dict(op='write-campaign', path=rel, expectedHash=None, text=text)
            runtime = dict(stateRevision=8, sessionId='submit-session')
            with mock.patch.object(save_storage, 'publish_campaign_projection', side_effect=OSError('publication failed')):
                with self.assertRaises(OSError): save_storage.perform_local_save_operation(payload, root, runtime)
            query = dict(op='save-receipt', path=rel, signature=campaign_save_signature(None, text))
            receipt = save_storage.perform_local_save_operation(query, root)
            self.assertTrue(receipt['committed']); self.assertFalse(receipt['matchesCurrent'])
            self.assertEqual(receipt['result']['stateRevision'], 8)
            self.assertEqual(receipt['result']['sessionId'], 'submit-session')
            self.assertFalse(Path(root, rel).exists())
            read = save_storage.perform_local_save_operation(dict(op='read-campaign', path=rel), root)
            self.assertEqual(read['sourceHash'], campaign_text_hash(text))
            retry = save_storage.perform_local_save_operation(payload, root, dict(stateRevision=9, sessionId='later-session'))
            self.assertTrue(retry['duplicate'])
            self.assertEqual((retry['stateRevision'], retry['sessionId']), (8, 'submit-session'))
            self.assertTrue(save_storage.perform_local_save_operation(query, root)['matchesCurrent'])


class OriginalWorkspaceHttpTests(CampaignRoomHttpTests):
    def test_formal_write_advances_cas_and_exact_replay_does_not_advance_twice(self):
        from server.web_entrances import WebEntrances
        headers = {'Host':'127.0.0.1:' + str(self.httpd.server_port),
                   'Origin':'http://127.0.0.1:' + str(self.httpd.server_port)}
        def api(path, data=None, status=200):
            code, body, _ = self.request(path, data, user=None, headers=headers)
            self.assertEqual(code, status, body)
            return json.loads(body)
        with mock.patch.object(SERVER, 'ACCOUNT_SETTINGS', dict(enabled=False, roomsEnabled=False)), \
                mock.patch.object(SERVER, 'WEB_ENTRANCES', WebEntrances({}, self.root)), \
                mock.patch.object(SERVER, 'STATE', None), mock.patch.object(SERVER, 'STATE_REVISION', 0), \
                mock.patch.object(SERVER, 'RECENT_ACTIONS', []):
            rel = '战役/original/当前存档.json'
            formal = dict(campaignId='original', state=dict(campaignId='original', campaignName='original', maps=[]))
            SERVER.perform_local_save_operation(dict(op='write-campaign', path=rel, expectedHash=None, text=json.dumps(formal)))
            read = api('/api/local-save', dict(op='read-campaign', path=rel))
            first = dict(formal['state'], protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,
                         _formalSourceHash=read['sourceHash'], expectedStateRevision=0, serverSessionId=SERVER.SESSION_ID)
            published = api('/api/state', first)
            guard = dict(expectedStateRevision=published['stateRevision'], serverSessionId=published['sessionId'])
            formal['state']['campaignName'] = 'DM A formally saved'
            text = json.dumps(formal)
            submitted = dict(op='write-campaign', path=rel, expectedHash=read['sourceHash'], text=text,
                             protocolVersion=SERVER.SERVER_PROTOCOL_VERSION, **guard)
            saved = api('/api/local-save', submitted)
            self.assertEqual(saved['stateRevision'], guard['expectedStateRevision'] + 1)
            self.assertEqual(SERVER.STATE['_formalSourceHash'], read['sourceHash'])
            self.assertEqual(api('/api/state', dict(first, **guard), status=409)['errorCode'], 'state-conflict')
            new_guard = dict(expectedStateRevision=saved['stateRevision'], serverSessionId=saved['sessionId'])
            self.assertEqual(api('/api/state', dict(first, **new_guard), status=409)['errorCode'], 'state-formal-conflict')
            self.assertEqual(api('/api/local-save', dict(submitted, expectedStateRevision=saved['stateRevision']))['stateRevision'], saved['stateRevision'])
            self.assertEqual(api('/api/info')['stateRevision'], saved['stateRevision'])
            receipt = api('/api/local-save', dict(op='save-receipt', path=rel,
                signature=campaign_save_signature(read['sourceHash'], text)))
            self.assertEqual(receipt['result']['stateRevision'], saved['stateRevision'])
            self.assertEqual(receipt['result']['sessionId'], saved['sessionId'])
            continuation = dict(formal['state'], protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,
                                _formalSourceHash=saved['hash'], **new_guard)
            after = api('/api/state', continuation)
            late_receipt = api('/api/local-save', dict(op='save-receipt', path=rel,
                signature=campaign_save_signature(read['sourceHash'], text)))
            self.assertEqual(late_receipt['result']['stateRevision'], saved['stateRevision'])
            self.assertEqual(late_receipt['stateRevision'], after['stateRevision'])
            self.assertNotEqual(late_receipt['stateRevision'], late_receipt['result']['stateRevision'])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(cls(name) for cls in (StatePublishGuardTests, OriginalWorkspaceGuardTests, OriginalWorkspaceHttpTests)
                              for name in sorted(cls.__dict__) if name.startswith('test_'))


if __name__ == '__main__': unittest.main()
