import copy
from unittest import mock
from test_resources import ResourceTests, SERVER
from server.resources import ResourceStore
from server.resource_database import ResourceDatabase


class WalletTests(ResourceTests):
    def command_wallet(self, action='credit', amount=10, **extra):
        cmd=dict(op='wallet',action=action,amount=amount,currency='gp',characterId=self.oid,
                 revision=self.r.read(self.pid)['revision'],requestId='wallet-request-0001',note='测试')
        cmd.update(extra)
        return cmd

    def test_wallet_credit_payment_and_idempotency(self):
        cmd=self.command_wallet()
        bag,_=self.r.apply(self.pid,'c1',cmd,True,state=self.state)
        self.assertEqual(bag['wallets'][self.oid]['balanceCp'],1000)
        self.r.apply(self.pid,'c1',cmd,True,state=self.state)
        self.assertEqual(self.r.read(self.pid)['wallets'][self.oid]['balanceCp'],1000)
        payment=self.command_wallet('debit',3,requestId='wallet-payment-0001',currency='sp')
        bag,_=self.r.apply(self.pid,'c1',payment,state=self.state)
        self.assertEqual(bag['wallets'][self.oid]['balanceCp'],970)
        self.assertEqual(len(bag['wallets'][self.oid]['history']),2)
        bag,_=self.r.apply(self.pid,'c1',dict(op='annotate',itemId=self.bag['items'][0]['id'],favorite=True,revision=bag['revision'],requestId='wallet-item-note-01'),state=self.state)
        self.assertEqual(bag['wallets'][self.oid]['balanceCp'],970)

    def test_wallet_transfer_atomic_and_private(self):
        self.r.apply(self.pid,'c1',self.command_wallet(),True,state=self.state)
        cmd=self.command_wallet('transfer',4,requestId='wallet-transfer-01',recipientId=self.target)
        before=copy.deepcopy(self.r.ledger())
        with mock.patch.object(self.r,'save',side_effect=OSError('disk failure')):
            with self.assertRaises(OSError): self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(self.r.ledger(),before)
        bag,_=self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(bag['wallets'][self.oid]['balanceCp'],600)
        self.assertNotIn(self.target,bag['wallets'])
        other=self.r.public(self.r.read(self.other))
        self.assertEqual(other['wallets'][self.target]['balanceCp'],400)
        self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(self.r.read(self.other)['wallets'][self.target]['balanceCp'],400)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.r.apply(self.pid,'c1',dict(cmd,amount=1),state=self.state)

    def test_wallet_rejects_unauthorized_and_invalid_operations(self):
        before=copy.deepcopy(self.r.ledger())
        bad=[self.command_wallet(),self.command_wallet('debit',1),self.command_wallet('debit',True),
             self.command_wallet('debit',-1),self.command_wallet('debit',1.5),
             self.command_wallet('debit',1,characterId=self.target)]
        for cmd in bad:
            with self.assertRaises(SERVER.profiles.ProfileError): self.r.apply(self.pid,'c1',cmd,state=self.state)
            self.assertEqual(self.r.ledger(),before)

    def test_wallet_global_persistence(self):
        data=self.r.ledger();data['characters']={'@global':data['characters']['c1']}
        ResourceDatabase(self.store.root.parent).activate(data,{pid:self.store.library(pid) for pid in (self.pid,self.other)},{'test':'wallet'})
        self.r=ResourceStore(self.store,SERVER.profiles)
        self.r.apply(self.pid,'c1',self.command_wallet(),True,state=self.state)
        self.r=ResourceStore(self.store,SERVER.profiles)
        self.assertEqual(self.r.read(self.pid,'different-campaign')['wallets'][self.oid]['balanceCp'],1000)

    def test_wallet_hidden_recipient_and_overdraft(self):
        self.r.apply(self.pid,'c1',self.command_wallet(),True,state=self.state)
        before=copy.deepcopy(self.r.ledger())
        self.state['maps'][0]['tokens'][1]['hiddenFromPlayers']=True
        for cmd in (self.command_wallet('transfer',1,requestId='wallet-hidden-001',recipientId=self.target),
                    self.command_wallet('debit',11,requestId='wallet-overdraft-01')):
            with self.assertRaises(SERVER.profiles.ProfileError):self.r.apply(self.pid,'c1',cmd,state=self.state)
            self.assertEqual(self.r.ledger(),before)

    def test_wallet_transfer_between_own_characters(self):
        oid=self.store.grant(self.pid,dict(name='同伴',hpMax=20,ac=12),'wallet-companion-01')['pieces'][-1]['ownedPieceId']
        self.state['maps'][0]['tokens'].append(dict(id='companion',ownedPieceId=oid,ownerPlayerId=self.pid,name='同伴',hp=20,hpMax=20,ac=12))
        self.r.reconcile(self.state,self.pid)
        self.r.apply(self.pid,'c1',self.command_wallet(),True,state=self.state)
        bag,_=self.r.apply(self.pid,'c1',self.command_wallet('transfer',2,requestId='wallet-own-transfer',recipientId=oid),state=self.state)
        self.assertEqual(bag['wallets'][self.oid]['balanceCp'],800)
        self.assertEqual(bag['wallets'][oid]['balanceCp'],200)

    def test_wallet_keeps_coins_and_excludes_electrum_from_change(self):
        self.r.apply(self.pid,'c1',self.command_wallet(amount=3),True,state=self.state)
        self.r.apply(self.pid,'c1',self.command_wallet(amount=2,currency='ep',requestId='wallet-electrum-01'),True,state=self.state)
        bag,_=self.r.apply(self.pid,'c1',self.command_wallet('transfer',5,currency='sp',recipientId=self.target,requestId='wallet-silver-001'),state=self.state)
        self.assertEqual(bag['wallets'][self.oid]['coins'],dict(pp=0,gp=2,ep=2,sp=5,cp=0))
        self.assertEqual(self.r.read(self.other)['wallets'][self.target]['coins']['sp'],5)
        self.r.apply(self.pid,'c1',self.command_wallet('debit',25,currency='sp',requestId='wallet-empty-gold'),state=self.state)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.r.apply(self.pid,'c1',self.command_wallet('transfer',1,recipientId=self.target,requestId='wallet-no-ep-auto'),state=self.state)
        bag,_=self.r.apply(self.pid,'c1',self.command_wallet('transfer',1,currency='ep',recipientId=self.target,requestId='wallet-explicit-ep'),state=self.state)
        self.assertEqual(bag['wallets'][self.oid]['coins']['ep'],1)
        self.assertEqual(self.r.read(self.other)['wallets'][self.target]['coins']['ep'],1)

    def test_wallet_does_not_create_electrum_from_gold(self):
        self.r.apply(self.pid,'c1',self.command_wallet(),True,state=self.state)
        before=copy.deepcopy(self.r.ledger())
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.r.apply(self.pid,'c1',self.command_wallet('transfer',1,currency='ep',recipientId=self.target,requestId='wallet-no-mint-ep'),state=self.state)
        self.assertEqual(self.r.ledger(),before)

    def test_legacy_wallet_coin_recovery(self):
        from server.wallet import coins_for
        self.assertEqual(coins_for(dict(balanceCp=150,history=[dict(deltaCp=100,effect='发放 1 GP'),dict(deltaCp=50,effect='发放 1 EP')]))['ep'],1)
        self.assertEqual(coins_for(dict(balanceCp=155,history=[])),dict(pp=0,gp=1,ep=0,sp=5,cp=5))
