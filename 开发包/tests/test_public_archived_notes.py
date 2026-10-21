"""Historical DM writing stays in private saves, never in public snapshots."""
import copy
import unittest
from unittest import mock
from test_player_profiles import SERVER


class PublicArchivedNotesTests(unittest.TestCase):
    def test_formal_source_lineage_stays_internal_to_the_checkpoint(self):
        state = dict(campaignId='c1', maps=[], _formalSourceHash='a' * 64)
        with mock.patch.object(SERVER, 'STATE', state):
            snapshot = SERVER.state_snapshot()
        self.assertNotIn('_formalSourceHash', snapshot)
        self.assertEqual(state['_formalSourceHash'], 'a' * 64)

    def test_public_character_action_receipts_do_not_expose_dm_conditions(self):
        token = dict(id='t1', ownedPieceId='o1', ownerPlayerId='p1', characterRevision=1,
                     conditions=[dict(name='private condition', visibility='gm'), dict(name='public condition')])
        state = dict(maps=[dict(id='m1', playerAccessible=True, tokens=[token])])
        public = SERVER.character_updates(state, public=True)
        private = SERVER.character_updates(state)
        self.assertEqual(public[0]['patch']['conditions'], [dict(name='public condition')])
        self.assertEqual(private[0]['patch']['conditions'], token['conditions'])

    def test_archived_and_old_dm_notes_are_hidden_without_mutating_the_save(self):
        token = dict(id='t1', publicNote='Public writing', gmNote='Original private writing',
                     legacyGmNote='Archived private writing', legacyGmNotes=['Additional private writing'],
                     legacyGmNoteHistory=['Conflicting historical writing'],
                     conditions=[dict(name='private condition', visibility='gm'), dict(name='public condition')])
        state = dict(campaignId='c1', maps=[dict(id='m1', playerAccessible=True, tokens=[token])])
        original = copy.deepcopy(state)
        with mock.patch.object(SERVER, 'STATE', state):
            snapshot = SERVER.state_snapshot()
        projected = snapshot['maps'][0]['tokens'][0]
        self.assertEqual(projected['publicNote'], 'Public writing')
        self.assertEqual(projected['conditions'], [dict(name='public condition')])
        for key in ('gmNote', 'legacyGmNote', 'legacyGmNotes', 'legacyGmNoteHistory'):
            self.assertNotIn(key, projected)
        self.assertEqual(state, original)
