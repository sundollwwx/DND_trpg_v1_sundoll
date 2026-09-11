import copy
from pathlib import Path
import unittest
from unittest import mock

from test_online_rules import SERVER


class JournalTests(unittest.TestCase):
    def setUp(self):
        state = {
            'campaignId': 'c1',
            'maps': [],
            'encounter': {'worldTime': {'totalSeconds': 28800, 'runningSince': None, 'rate': 1}},
        }
        for name, value in {
            'STATE': state,
            'RECENT_ACTIONS': [],
            'NEXT_SEQ': 1,
            'STATE_REVISION': 0,
            'ACTION_RATE': {},
        }.items():
            patch = mock.patch.object(SERVER, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def post(self, data, session=None, local=False):
        handler = mock.Mock()
        handler.path = '/api/journal'
        handler._read_json_body.return_value = data
        with mock.patch.object(SERVER, 'session_from_request', return_value=session), \
                mock.patch.object(SERVER, 'is_local_request', return_value=local), \
                mock.patch.object(SERVER, 'broadcast') as broadcast:
            SERVER.Handler.do_POST(handler)
        args = handler._send_json.call_args.args
        return args[0], (args[1] if len(args) > 1 else 200), broadcast

    @staticmethod
    def create(title='抵达古堡', text='探索古堡', revision=0, session_token='valid'):
        return {
            'campaignId': 'c1',
            'revision': revision,
            'operation': 'create',
            'entry': {'title': title, 'text': text},
            'sessionToken': session_token,
        }

    def test_log_cards_and_client_use_named_entry_model(self):
        root = Path(__file__).resolve().parents[1] / '主控台'
        for filename, attribute, card_id in [
            ('主控台.html', 'data-workspace', 'journal-card'),
            ('玩家.html', 'data-player-workspace', 'player-journal-card'),
        ]:
            html = (root / filename).read_text(encoding='utf-8')
            entry = html.index(f'id="{card_id}"')
            section = html[entry:html.index('</section>', entry)]
            self.assertIn('<h2>📖 战役日志</h2>', section)
            self.assertIn('CampaignJournal.open()', section)
            self.assertEqual(html.index(f'{attribute}="resources"'), entry + section.index(f'{attribute}="resources"'))
        source = (root / 'journal.js').read_text(encoding='utf-8')
        self.assertIn('id="journal-title"', source)
        self.assertIn('journal-delete', source)
        self.assertIn('journal-page-previous', source)
        self.assertIn('journal-entry-previous', source)
        self.assertIn('choosePage(draftPageIndex + 2, 1)', source)
        self.assertIn('FALLBACK_PAGE_CHAR_LIMIT = 224', source)
        self.assertIn('function measuredPageCut(', source)
        self.assertIn('function repaginateDraftFrom(', source)
        self.assertIn('function bookPageMetrics()', source)
        self.assertIn("chooseEntry(base.entries[previousIndex].id, -1, 'last')", source)
        self.assertIn("chooseEntry(base.entries[index + 1].id, 1, 'first')", source)
        self.assertIn("dialog.classList.toggle('journal-continuation-spread'", source)
        css = (root / 'journal.css').read_text(encoding='utf-8')
        self.assertIn('.journal-book.journal-continuation-spread', css)
        self.assertIn('function preparePageTurn(direction)', source)
        self.assertIn('function playPageTurn(sheet, direction)', source)
        self.assertIn('journal-page-stationary-sheet', source)
        self.assertIn('journal-title-snapshot', source)
        self.assertIn("face.querySelectorAll('[id]')", source)
        self.assertIn('journal-page-turn-landing', source)
        self.assertIn('date.textContent = `日期 · ${worldDate(', source)
        self.assertNotIn('战役时间 · ${worldDate(', source)
        self.assertIn('journal-left-page', source)
        self.assertIn('journal-right-page', source)
        self.assertIn('journal-directory-toggle', source)
        self.assertIn('function directoryDrawer()', source)
        self.assertIn('drawer.hidden = !open', source)
        self.assertIn('requestCloseBook', source)
        self.assertIn('.journal-book:not([open]){display:none}', css)
        self.assertIn('第 ${span.start}–${span.end} 页', source)
        self.assertIn('全书共 ${book.total} 页', source)
        self.assertIn("operation: 'create'", source)
        host_source = (root / 'app.js').read_text(encoding='utf-8')
        player_source = (root / '玩家.html').read_text(encoding='utf-8')
        self.assertIn('isDM: true', host_source)
        self.assertIn('mutate: async (mutation, revision, campaignId)', host_source)
        self.assertIn('isDM:false', player_source)
        self.assertIn('canEdit:entry=>', player_source)
        self.assertIn('canDelete:entry=>', player_source)
        self.assertIn('mutate:async(mutation,revision,campaignId)', player_source)
        self.assertIn("const dice = visible.find((card) => card.querySelector('#btn-roll'))", host_source)
        self.assertIn("card.classList.toggle('collapsed', card !== dice)", host_source)

    def test_player_author_is_server_assigned_and_can_rename_their_own_entry(self):
        response, status, broadcast = self.post(
            dict(self.create(), author='DM'), {'name': 'Alice'}
        )
        self.assertEqual(status, 200)
        entry = response['journal']['entries'][0]
        self.assertEqual(entry['author'], 'Alice')
        self.assertEqual(entry['title'], '抵达古堡')
        self.assertEqual(response['journal']['history'][-1]['author'], 'Alice')
        self.assertEqual(response['entryId'], entry['id'])
        broadcast.assert_called_once()

        update = {
            'campaignId': 'c1', 'revision': 1, 'operation': 'update', 'entryId': entry['id'],
            'entry': {'title': '北塔的灯', 'text': '今晚改查北塔。'}, 'sessionToken': 'valid', 'author': 'DM',
        }
        response, status, _ = self.post(update, {'name': 'Alice'})
        self.assertEqual(status, 200)
        changed = response['journal']['entries'][0]
        self.assertEqual((changed['title'], changed['text'], changed['author'], changed['updatedBy']),
                         ('北塔的灯', '今晚改查北塔。', 'Alice', 'Alice'))

        response, status, _ = self.post({
            'campaignId': 'c1', 'revision': 2, 'operation': 'delete', 'entryId': entry['id'],
            'sessionToken': 'valid',
        }, {'name': 'Alice'})
        self.assertEqual(status, 200)
        self.assertEqual(response['journal']['entries'], [])
        self.assertEqual(response['journal']['history'][-1]['author'], 'Alice')

    def test_player_cannot_modify_or_delete_another_authors_entry(self):
        created, status, _ = self.post(self.create(session_token=''), local=True)
        self.assertEqual(status, 200)
        entry_id = created['entryId']
        update = {
            'campaignId': 'c1', 'revision': 1, 'operation': 'update', 'entryId': entry_id,
            'entry': {'title': '冒充标题', 'text': '冒充正文'}, 'sessionToken': 'valid',
        }
        response, status, event = self.post(update, {'name': 'Alice'})
        self.assertEqual(status, 403)
        self.assertIn('只能修改自己', response['error'])
        self.assertEqual(SERVER.STATE['journal']['entries'][0]['title'], '抵达古堡')
        event.assert_not_called()

        delete = {'campaignId': 'c1', 'revision': 1, 'operation': 'delete', 'entryId': entry_id, 'sessionToken': 'valid'}
        response, status, event = self.post(delete, {'name': 'Alice'})
        self.assertEqual(status, 403)
        self.assertIn('只能删除自己', response['error'])
        self.assertEqual(len(SERVER.STATE['journal']['entries']), 1)
        event.assert_not_called()

    def test_dm_can_rename_rewrite_and_delete_any_entry(self):
        created, status, _ = self.post(self.create(), {'name': 'Alice'})
        self.assertEqual(status, 200)
        entry_id = created['entryId']
        update = {
            'campaignId': 'c1', 'revision': 1, 'operation': 'update', 'entryId': entry_id,
            'entry': {'title': 'DM 整理：北塔', 'text': '由 DM 补全的线索。'},
        }
        response, status, _ = self.post(update, local=True)
        self.assertEqual(status, 200)
        entry = response['journal']['entries'][0]
        self.assertEqual(entry['author'], 'Alice')
        self.assertEqual(entry['updatedBy'], 'DM')
        self.assertEqual(entry['title'], 'DM 整理：北塔')

        response, status, _ = self.post({
            'campaignId': 'c1', 'revision': 2, 'operation': 'delete', 'entryId': entry_id,
        }, local=True)
        self.assertEqual(status, 200)
        self.assertEqual(response['journal']['entries'], [])
        self.assertEqual(response['journal']['history'][-1]['action'], 'delete')

    def test_stale_revision_never_overwrites_newer_entry(self):
        response, status, _ = self.post(self.create(), {'name': 'Alice'})
        self.assertEqual(status, 200)
        entry_id = response['entryId']
        response, status, _ = self.post({
            'campaignId': 'c1', 'revision': 0, 'operation': 'update', 'entryId': entry_id,
            'entry': {'title': '过期标题', 'text': '过期正文'}, 'sessionToken': 'valid',
        }, {'name': 'Alice'})
        self.assertEqual(status, 409)
        self.assertIn('其他人修改', response['error'])
        self.assertEqual(SERVER.STATE['journal']['entries'][0]['title'], '抵达古堡')

    def test_legacy_single_text_log_migrates_to_titled_entries(self):
        migrated = SERVER.normalize_journal({
            'text': '第一页\f第二页', 'revision': 5, 'author': 'DM',
            'worldSeconds': 633600, 'history': [{'author': 'DM'}],
        })
        self.assertEqual([entry['title'] for entry in migrated['entries']], ['未命名日志 1', '未命名日志 2'])
        self.assertEqual([entry['text'] for entry in migrated['entries']], ['第一页', '第二页'])
        self.assertEqual(migrated['text'], '第一页\f第二页')

        SERVER.STATE['journal'] = {'text': '第一页\f第二页', 'revision': 5, 'author': 'DM'}
        response, status, _ = self.post({
            'campaignId': 'c1', 'revision': 5, 'operation': 'update', 'entryId': 'legacy-1',
            'entry': {'title': '序章', 'text': '更新后的第一页'},
        }, local=True)
        self.assertEqual(status, 200)
        self.assertEqual(response['journal']['entries'][0]['title'], '序章')
        self.assertEqual(response['journal']['entries'][1]['text'], '第二页')

    def test_journal_is_bound_to_the_current_campaign(self):
        response, status, _ = self.post(self.create(session_token=''), local=True)
        self.assertEqual(status, 200)
        self.assertEqual(response['journal']['campaignId'], 'c1')
        self.assertEqual(SERVER.STATE['journal']['campaignId'], 'c1')

        foreign = SERVER.normalize_journal(response['journal'], 'c2')
        self.assertEqual(foreign['campaignId'], 'c2')
        self.assertEqual(foreign['entries'], [])
        foreign_action = copy.deepcopy(SERVER.RECENT_ACTIONS[-1])
        foreign_action['journal']['campaignId'] = 'c2'
        self.assertFalse(SERVER.apply_action({'campaignId': 'c1'}, foreign_action))

    def test_limits_and_input_validation_are_enforced(self):
        response, status, _ = self.post(self.create(title='题' * 81, session_token=''), local=True)
        self.assertEqual(status, 400)
        self.assertIn('标题最多', response['error'])
        response, status, _ = self.post(self.create(text='字' * 20001, session_token=''), local=True)
        self.assertEqual(status, 400)
        self.assertIn('正文最多', response['error'])

        SERVER.STATE['journal'] = {'entries': [
            {'id': 'entry-%d' % index, 'title': '日志 %d' % index, 'text': '', 'author': 'DM'}
            for index in range(SERVER.MAX_JOURNAL_ENTRIES)
        ], 'revision': 4}
        response, status, _ = self.post(self.create(revision=4, session_token=''), local=True)
        self.assertEqual(status, 400)
        self.assertIn('最多可建立', response['error'])

        SERVER.STATE['journal'] = {'entries': [
            {'id': 'entry-full', 'title': '已满', 'text': '字' * 20000, 'author': 'DM'}
        ], 'revision': 8}
        response, status, _ = self.post(self.create(text='再写一点', revision=8, session_token=''), local=True)
        self.assertEqual(status, 400)
        self.assertIn('合计最多', response['error'])

    def test_server_uses_campaign_clock_and_replay_is_idempotent(self):
        SERVER.STATE['encounter']['worldTime'] = {'totalSeconds': 28800, 'runningSince': 1000000, 'rate': 2}
        with mock.patch.object(SERVER.time, 'time', return_value=1005):
            response, status, _ = self.post(self.create(session_token=''), local=True)
        self.assertEqual(status, 200)
        entry = response['journal']['entries'][0]
        self.assertEqual(entry['createdWorldSeconds'], 28810)
        self.assertEqual(entry['updatedWorldSeconds'], 28810)
        action = copy.deepcopy(SERVER.RECENT_ACTIONS[-1])
        replay = {'campaignId': 'c1'}
        self.assertTrue(SERVER.apply_action(replay, action))
        saved = copy.deepcopy(replay)
        self.assertTrue(SERVER.apply_action(replay, action))
        self.assertEqual(saved, replay)
        self.assertFalse(SERVER.apply_action({'campaignId': 'c2'}, action))
        self.assertEqual(SERVER.state_snapshot()['journal']['entries'][0]['title'], '抵达古堡')


if __name__ == '__main__':
    unittest.main()
