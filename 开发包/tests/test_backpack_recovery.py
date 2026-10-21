"""Lost HTTP replies can be verified after a context switch without new writes."""
import copy
import hashlib
import http.client
import json
import socket
import unittest
from unittest import mock
import test_backpack_notifications as fixtures
from server.content_packages import ContentPackages
from server.inventory import inventory_request_signature
from server.resources import ResourceStore, resource_request_signature
from server.resource_database import ResourceDatabase
from server.module_store import ModuleStore
from server.wallet import wallet_request_signature

SERVER = fixtures.SERVER


class BackpackRecoveryTests(unittest.TestCase):
    setUp = fixtures.BackpackNotificationTests.setUp
    close_server = fixtures.BackpackNotificationTests.close_server
    request = fixtures.BackpackNotificationTests.request
    login = fixtures.BackpackNotificationTests.login
    backpack = fixtures.BackpackNotificationTests.backpack
    grant = fixtures.BackpackNotificationTests.grant

    def drop_reply(self, command, host=False):
        send = SERVER.Handler._send_document_json
        dropped = []
        def lose_reply(handler, value, *args, **kwargs):
            if not dropped and value.get('event', {}).get('id') == command['requestId']:
                dropped.append(True)
                handler.close_connection = True
                handler.connection.shutdown(socket.SHUT_RDWR)
                return
            return send(handler, value, *args, **kwargs)
        with mock.patch.object(SERVER.Handler, '_send_document_json', lose_reply):
            with self.assertRaises(http.client.RemoteDisconnected):
                self.request(command, host=host, path='/api/backpack')
        self.assertEqual(dropped, [True])
        data = ResourceStore(self.store, SERVER.profiles).receipt_ledger()
        self.assertIn(command['requestId'], data['backpacks'][self.pid]['receipts'])
        return data

    def switch(self, boundary):
        if boundary == 'campaign':
            SERVER.STATE['campaignId'] = 'c2'
        else:
            policy = ContentPackages(self.save)
            current = policy.context('c1')
            policy.set_enabled('c1', [], current['selectionRevision'], 'recovery-disable-packages')

    def saved_bytes(self):
        # SQLite shared-memory indexes are transient coordination, not save documents.
        return {str(path.relative_to(self.save)): path.read_bytes() for path in self.save.rglob('*')
                if path.is_file() and not path.name.endswith('-shm')}

    def recover(self, command, host=False):
        before = self.saved_bytes()
        state = copy.deepcopy(SERVER.STATE)
        ledger = ResourceStore(self.store, SERVER.profiles).receipt_ledger()
        SERVER.broadcast.reset_mock()
        with mock.patch.object(ResourceStore, 'save', side_effect=AssertionError('recovery must not save')), \
             mock.patch.object(ResourceStore, 'reconcile', side_effect=AssertionError('recovery must not reconcile')), \
             mock.patch.object(ResourceStore, 'characters', side_effect=AssertionError('recovery must not initialize character libraries')), \
             mock.patch.object(ModuleStore, 'connect', side_effect=AssertionError('recovery must not initialize SQLite/projections')), \
             mock.patch.object(SERVER.profiles, 'atomic', side_effect=AssertionError('recovery must not write files')), \
             mock.patch('server.resources.secrets.randbelow', side_effect=AssertionError('recovery must not roll')):
            status, result = self.request(command, host=host, path='/api/backpack')
        self.assertEqual(status, 200, result)
        self.assertIs(result['recovered'], True)
        self.assertEqual(result['campaignId'], SERVER.STATE['campaignId'])
        self.assertEqual(result['packageContextRevision'], ContentPackages(self.save).context(SERVER.STATE['campaignId'])['revision'])
        self.assertEqual(result['event']['id'], command['requestId'])
        self.assertEqual(self.saved_bytes(), before)
        self.assertEqual(ResourceStore(self.store, SERVER.profiles).receipt_ledger(), ledger)
        self.assertEqual(SERVER.STATE, state)
        SERVER.broadcast.assert_not_called()
        return result

    def prepare(self, op):
        wine = dict(name='待核对的酒', category='gear', rarity='', consumable=True, effect='饮用', scope='general')
        if op == 'grant':
            status, read = self.backpack(dict(op='get', sessionToken=self.session))
            self.assertEqual(status, 200, read)
            return dict(op='grant', playerId=self.pid, characterId=self.oid, item=wine, quantity=2,
                revision=read['backpack']['revision'], packageContextRevision=read['packageContextRevision'],
                campaignId='c1', requestId='recovery-grant-0001'), True
        if op == 'wallet':
            credit = dict(op='wallet', playerId=self.pid, characterId=self.oid, action='credit', amount=5,
                          currency='gp', note='准备余额', revision=0, requestId='recovery-wallet-credit')
            status, result = self.backpack(credit, True)
            self.assertEqual(status, 200, result)
            command = dict(op='wallet', characterId=self.oid, action='debit', amount=2, currency='gp', note='支付')
        else:
            _, result = self.grant(wine if op == 'use' else None, quantity=2)
            command = dict(op=op, itemId=result['backpack']['items'][0]['id'])
            if op == 'heal':
                target = next(c for c in result['characters'] if c['id'] == self.oid)
                command.update(characterId=self.oid, sourceCharacterId=self.oid, targetRevision=target['revision'])
            if op == 'transfer':
                other = self.store.create('其他玩家')['profile']['playerId']
                piece = self.store.grant(other, dict(name='接收角色', type='pc', hpMax=10),
                                         'recovery-transfer-recipient')['pieces'][0]
                SERVER.STATE['maps'][0]['tokens'].append(dict(piece, id='receiver', hp=10, x=80, y=80))
                # Normal GET establishes the recipient resource without changing the source bag.
                status, read = self.backpack(dict(op='get', sessionToken=self.session))
                self.assertEqual(status, 200, read)
                command.update(characterId=piece['ownedPieceId'], quantity=1)
        command.update(campaignId='c1', sessionToken=self.session, revision=result['backpack']['revision'],
                       packageContextRevision=result['packageContextRevision'], requestId='recovery-'+op+'-0001')
        return command, False

    def assert_flow(self, op, boundary):
        command, host = self.prepare(op)
        committed = self.drop_reply(command, host)
        self.switch(boundary)
        result = self.recover(command, host)
        self.assertEqual(ResourceStore(self.store, SERVER.profiles).receipt_ledger(), committed)
        if boundary == 'package' and op != 'wallet':
            self.assertEqual(result['backpack']['items'], [])
            self.assertEqual(result['event']['op'], 'unavailable')
        return command, host, result

    def test_use_after_campaign_switch(self): self.assert_flow('use', 'campaign')
    def test_use_after_package_switch(self): self.assert_flow('use', 'package')
    def test_heal_after_campaign_switch(self): self.assert_flow('heal', 'campaign')
    def test_heal_after_package_switch(self): self.assert_flow('heal', 'package')
    def test_transfer_after_campaign_switch(self): self.assert_flow('transfer', 'campaign')
    def test_transfer_after_package_switch(self): self.assert_flow('transfer', 'package')
    def test_wallet_after_campaign_switch(self): self.assert_flow('wallet', 'campaign')
    def test_wallet_after_package_switch(self): self.assert_flow('wallet', 'package')
    def test_grant_after_campaign_switch(self): self.assert_flow('grant', 'campaign')
    def test_grant_after_package_switch(self): self.assert_flow('grant', 'package')

    def test_disabled_document_body_and_history_are_not_leaked(self):
        status, read = self.backpack(dict(op='get', sessionToken=self.session))
        secret = '禁止泄露的正文-47c6c93e'
        command = dict(op='grant', playerId=self.pid, characterId=self.oid, campaignId='c1', quantity=1,
            item=dict(name='秘密书籍', category='document', documentType='book', rarity='', consumable=False, scope='general',
                      effect='阅读', description='禁止泄露的物品故事', body=secret),
            revision=read['backpack']['revision'], packageContextRevision=read['packageContextRevision'],
            requestId='recovery-secret-document')
        self.drop_reply(command, True)
        self.switch('package')
        result = self.recover(command, True)
        self.assertEqual(result['backpack']['items'], [])
        self.assertEqual(result['backpack']['history'], [])
        self.assertEqual(result['event']['op'], 'unavailable')
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(secret, serialized)
        self.assertNotIn('禁止泄露的物品故事', serialized)

    def test_missing_receipt_remains_rejected_without_new_mutation(self):
        command, host = self.prepare('use')
        self.switch('campaign')
        before = self.saved_bytes()
        SERVER.broadcast.reset_mock()
        with mock.patch.object(ResourceStore, 'apply', side_effect=AssertionError('old context must not execute')):
            status, result = self.request(command, host=host, path='/api/backpack')
        self.assertEqual(status, 409, result)
        self.assertNotIn('recovered', result)
        self.assertEqual(self.saved_bytes(), before)
        SERVER.broadcast.assert_not_called()

    def test_tampered_quantity_character_version_and_operation_are_rejected(self):
        command, host = self.prepare('transfer')
        self.drop_reply(command, host)
        self.switch('campaign')
        before = self.saved_bytes()
        for patch in (dict(quantity=2), dict(characterId=self.oid), dict(revision=0), dict(op='heal')):
            with self.subTest(patch=patch):
                status, result = self.request(dict(command, **patch), path='/api/backpack')
                self.assertEqual(status, 409, result)
                self.assertNotIn('recovered', result)
                self.assertEqual(self.saved_bytes(), before)

    def test_host_receipt_cannot_be_recovered_as_player_or_by_another_player(self):
        command, host = self.prepare('grant')
        self.drop_reply(command, host)
        self.switch('campaign')
        before = self.saved_bytes()
        status, result = self.request(dict(command, sessionToken=self.session), path='/api/backpack')
        self.assertEqual(status, 409, result)
        self.assertEqual(self.saved_bytes(), before)
        other = self.store.create('不相关的玩家')
        other_session = self.request(dict(credential=other['credential']), path='/api/session')[1]['session']['sessionToken']
        before = self.saved_bytes()
        status, result = self.request(dict(command, sessionToken=other_session), path='/api/backpack')
        self.assertEqual(status, 403, result)
        self.assertEqual(self.saved_bytes(), before)

    def test_wallet_amount_and_currency_tampering_cannot_restore_receipt(self):
        command, host = self.prepare('wallet')
        self.drop_reply(command, host)
        self.switch('campaign')
        before = self.saved_bytes()
        for patch in (dict(amount=3), dict(currency='pp'), dict(recipientId=self.oid), dict(note='更改备注')):
            with self.subTest(patch=patch):
                status, result = self.request(dict(command, **patch), path='/api/backpack')
                self.assertEqual(status, 409, result)
                self.assertEqual(self.saved_bytes(), before)

    def test_sqlite_recovery_uses_readonly_connection_and_keeps_original_bytes(self):
        command, host = self.prepare('use')
        resource = ResourceStore(self.store, SERVER.profiles)
        data = resource.ledger()
        data['characters'] = {'@global': data['characters']['c1']}
        ResourceDatabase(self.save).activate(data, {self.pid: self.store.library(self.pid)}, {'test': 'recovery'})
        self.drop_reply(command, host)
        self.switch('campaign')
        result = self.recover(command, host)
        self.assertEqual(result['backpack']['items'][0]['quantity'], 1)


class SignatureCompatibilityTests(unittest.TestCase):
    def test_inventory_signature_keeps_old_fields_and_unicode_encoding(self):
        for command in [dict(op='grant', item=dict(name='书籍', body='第一页\f第二页'), quantity=1, revision=3,
                             templateId='模板', characterId='角色', campaignId='ignored'),
                        dict(op='annotate', itemId='i1', notes='留到明天', favorite=True, revision=4),
                        dict(op='restore', removalId='removed-0001', revision=5)]:
            with self.subTest(op=command['op']):
                old = {k: command.get(k) for k in ('op', 'itemId', 'presetId', 'item', 'quantity', 'revision')}
                if 'templateId' in command or 'templateVersion' in command:
                    old.update(templateId=command.get('templateId'), templateVersion=command.get('templateVersion'))
                if command['op'] in ('restore', 'purge'): old['removalId'] = command.get('removalId')
                if command['op'] == 'annotate': old.update(favorite=command.get('favorite'), notes=command.get('notes'))
                old['host'] = True
                if 'characterId' in command: old['characterId'] = command['characterId']
                digest = hashlib.sha256(json.dumps(old, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                self.assertEqual(inventory_request_signature(command, True), digest)

    def test_resource_signature_preserves_optional_quantity_and_old_campaign_binding(self):
        for command in (dict(op='heal', itemId='i1', targetRevision=4, sourceCharacterId='角色'),
                        dict(op='transfer', itemId='i1', characterId='角色', quantity=2),
                        dict(op='transfer', itemId='i1', characterId='角色')):
            old = {k: command.get(k) for k in ('op','itemId','revision','characterId','targetRevision','sourceCharacterId','eventId')}
            if command['op'] == 'transfer' and 'quantity' in command: old['quantity'] = command['quantity']
            old.update(host=False, campaign='战役')
            digest = hashlib.sha256(json.dumps(old, sort_keys=True).encode()).hexdigest()
            self.assertEqual(resource_request_signature(command, '战役', False), digest)

    def test_wallet_signature_preserves_established_fields_and_encoding(self):
        command = dict(op='wallet', revision=3, characterId='角色', action='debit', amount=2, currency='gp', note='私密备注')
        old = {k: command.get(k) for k in ('op', 'revision', 'characterId', 'recipientId', 'action', 'amount', 'currency', 'note')}
        old.update(host=False, campaign='战役')
        digest = hashlib.sha256(json.dumps(old, sort_keys=True).encode()).hexdigest()
        self.assertEqual(wallet_request_signature(command, '战役', False), digest)


if __name__ == '__main__':
    unittest.main()
