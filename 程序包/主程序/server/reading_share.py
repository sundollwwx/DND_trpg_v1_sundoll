"""Short-lived reading invitations. Only explicit acceptance reveals the text."""
import copy
import secrets
import time


class ReadingShares:
    def __init__(self, error, clock=None):
        self.error = error
        self.clock = clock or time.time
        self.entries = {}

    def prune(self, campaign):
        now = self.clock()
        self.entries = {k: v for k, v in self.entries.items()
                        if v['expires'] > now and v['campaign'] == campaign}

    def invite(self, campaign, sender, name, item, recipients):
        self.prune(campaign)
        if (item.get('category') != 'document' or item.get('documentType') not in ('letter', 'book')
                or not item.get('body', '').strip() or item.get('quantity', 0) <= 0):
            raise self.error('只能共享持有的信件或书籍', 400)
        if any(v['sender'] == sender and self.clock() - v['created'] < 10 for v in self.entries.values()):
            raise self.error('刚刚已发送共享邀请，请稍候再试', 429)
        recipients = set(recipients) - {sender}
        if not recipients:
            raise self.error('目前没有其他在线玩家可以接收共享', 409)
        if len(self.entries) >= 100:
            raise self.error('共享邀请较多，请稍后再试', 429)
        identity = secrets.token_hex(24)
        now = self.clock()
        self.entries[identity] = dict(campaign=campaign, sender=sender, created=now,
            expires=now+120, recipients=recipients,
            item={k: copy.deepcopy(item[k]) for k in ('name', 'category', 'documentType', 'body')})
        return dict(type='readingInvite', shareId=identity, campaignId=campaign,
                    senderId=sender, senderName=name, name=item['name'],
                    documentType=item['documentType'], recipients=sorted(recipients), expiresAt=int((now+120)*1000))

    def accept(self, campaign, identity, player):
        self.prune(campaign)
        entry = self.entries.get(identity)
        if not entry:
            raise self.error('这次阅读共享已过期，请让对方重新共享', 410)
        if player not in entry['recipients']:
            raise self.error('你不在这次阅读共享的接收名单中', 403)
        return copy.deepcopy(entry['item'])
