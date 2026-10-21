from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import unittest
from test_online_rules import SERVER, make_state

class PortraitSwitchTests(unittest.TestCase):
    def action(self, index, actor='Alice'):
        return {'op':'patchToken','tokenId':'rider','mapId':'map-1','actor':actor,'playMode':'free','patch':{'portraitVariant':index}}
    def state(self):
        state=make_state('free')
        state['maps'][0]['tokens'][0]['portraitVariants']=[{'name':'常态','iconImgPath':'立绘/常态.png'},{'name':'施法','iconImgPath':'立绘/施法.png'}]
        return state
    def test_valid_choice_changes_image_and_clears_old_cache(self):
        s=self.state();t=s['maps'][0]['tokens'][0];t['iconImg']='old'
        self.assertTrue(SERVER.apply_action(s,self.action(1)))
        self.assertEqual(t['iconImgPath'],'立绘/施法.png');self.assertIsNone(t['iconImg'])
    def test_choice_remains_same_form_after_concurrent_reorder(self):
        s=self.state();t=s['maps'][0]['tokens'][0]
        wanted=dict(t['portraitVariants'][1])
        t['portraitVariants'].reverse()
        action=self.action(1)
        action['patch']['portraitVariantSource']=wanted
        self.assertTrue(SERVER.apply_action(s,action))
        self.assertEqual(t['iconImgPath'],'立绘/施法.png')
        self.assertEqual(action['patch']['portraitVariant'],0)
    def test_removed_form_is_rejected_instead_of_switching_to_different_form(self):
        s=self.state();action=self.action(0)
        action['patch']['portraitVariantSource']={'iconImgPath':'立绘/不存在.png'}
        self.assertFalse(SERVER.apply_action(s,action))

    def test_invalid_indices_rejected(self):
        for index in [-1,2,'1',True,{},None]:
            s=self.state();self.assertFalse(SERVER.apply_action(s,self.action(index)))
            self.assertNotIn('portraitVariant',s['maps'][0]['tokens'][0])
    def test_other_player_rejected(self):
        self.assertFalse(SERVER.apply_action(self.state(),self.action(0,'Bob')))
    def test_arbitrary_path_not_accepted(self):
        s=self.state();a=self.action(0);a['patch']={'iconImgPath':'https://invalid.test/x'}
        self.assertFalse(SERVER.apply_action(s,a))

if __name__=='__main__':unittest.main()
