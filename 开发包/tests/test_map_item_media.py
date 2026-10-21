import copy
import unittest
from unittest import mock
from test_player_profiles import SERVER
from server.content_packages import local_package_id

class MapItemMediaTests(unittest.TestCase):
    def setUp(self):
        self.art='/api/module-assets/'+'a'*64
        self.secret='/api/module-assets/'+'b'*64
        self.origin=dict(sourceScope='general', sourcePackageId=local_package_id('general:本地通用'))
        self.marker=dict(visible=True,locked=False,items=[dict(image=self.art, **self.origin)])
        self.state=dict(campaignId='c1',activeMapId='m2',maps=[dict(id='m1',playerAccessible=True),dict(id='m2')])
        self.ledger=dict(mapItems={'c1':{'m1':dict(markers=[self.marker])}})
    def allowed(self,url=None):
        with mock.patch.object(SERVER,'profile_store'),mock.patch.object(SERVER.ResourceStore,'ledger',return_value=self.ledger):
            return SERVER.map_item_media_is_public(url or self.art,self.state)
    def test_revealed_map_item_art_is_available_without_owning_item(self):
        self.assertTrue(self.allowed())
        with mock.patch.object(SERVER,'STATE',self.state),mock.patch.object(SERVER,'host_request_allowed',return_value=False),mock.patch.object(SERVER,'module_asset_is_public',return_value=False),mock.patch.object(SERVER,'profile_store'),mock.patch.object(SERVER.ResourceStore,'ledger',return_value=self.ledger):
            self.assertTrue(SERVER.private_media_allowed(mock.Mock(headers={}),self.art))
    def test_hidden_map_marker_and_other_campaign_stay_private(self):
        self.marker['visible']=False;self.assertFalse(self.allowed());self.marker['visible']=True
        self.state['maps'][0]['playerAccessible']=False;self.assertFalse(self.allowed())
        self.state['activeMapId']='m1';self.assertTrue(self.allowed())
        self.state['campaignId']='c2';self.assertFalse(self.allowed())
    def test_locked_chest_reveals_shell_not_contents_or_nested_secrets(self):
        self.marker.update(locked=True,containerItem=dict(image=self.secret,description=self.art, **self.origin))
        self.assertTrue(self.allowed(self.secret));self.assertFalse(self.allowed())
        self.marker['locked']=False;self.assertTrue(self.allowed())
        self.marker['items']=[];self.assertFalse(self.allowed())
    def test_unknown_url_or_missing_state_denied(self):
        self.assertFalse(self.allowed(self.secret));self.assertFalse(self.allowed('/api/assets/private'))
        self.state=None;self.assertFalse(self.allowed())

    def test_unloaded_campaign_art_stays_private_even_when_the_marker_is_visible(self):
        self.marker['items'][0].update(sourceScope='campaign', sourcePackageId=local_package_id('campaign:c2'), sourceCampaignId='c2')
        self.assertFalse(self.allowed())
        self.state['campaignId']='c2'
        self.ledger['mapItems']['c2']=self.ledger['mapItems']['c1']
        self.assertTrue(self.allowed())

    def test_unloaded_container_hides_its_contents_art(self):
        self.marker['containerItem']=dict(image=self.secret, sourceScope='campaign',
            sourcePackageId=local_package_id('campaign:c2'), sourceCampaignId='c2')
        self.assertFalse(self.allowed())

if __name__=='__main__':unittest.main()
