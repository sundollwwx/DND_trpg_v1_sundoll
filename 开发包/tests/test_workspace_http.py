from test_module_http import ModuleHttpTests, SERVER
from server.workspace import enable
from server.module_runtime import ModuleRuntime
from unittest import mock


class WorkspaceHttpTests(ModuleHttpTests):
    """Repeat real HTTP ownership/reveal/revocation contracts on sibling storage."""
    def setUp(self):
        super().setUp()
        self.save=enable(self.root/'同级工作区')
        patch=mock.patch.object(SERVER,'LOCAL_SAVE_ROOT',str(self.save))
        patch.start();self.addCleanup(patch.stop)
        ModuleRuntime(self.save,self.root).ensure_empty_runtime()
        self.created=SERVER.profile_store().create('测试玩家')
        self.pid=self.created['profile']['playerId']

    def test_management_and_private_backup_are_host_only(self):
        for operation in ('overview','backups','backup-create','backup-restore','uninstall','restore-module','export-general'):
            with mock.patch.object(SERVER,'local_save_request_allowed',return_value=False):
                code,_=self.request({'op':operation},path='/api/modules',host=True)
            self.assertEqual(code,403,operation)
        code,result=self.request({'op':'overview'},path='/api/modules',host=True)
        self.assertEqual(code,200,result)
        self.assertEqual(len(result['players']),1)
        self.assertNotIn('credential',str(result))

    def test_workspace_generation_rejects_all_old_mutations(self):
        from server.workspace import atomic_json
        atomic_json(self.save.parent/'工作区代次.json',{'epoch':'new-workspace'})
        for path,body in [('/api/modules',{'op':'overview'}),('/api/item-library',{'op':'get'}),('/api/player-profiles',{'op':'list'}),('/api/local-save',{'op':'status'})]:
            self.assertEqual(self.request(body,path=path,host=True)[0],409)
        code,result=self.request({'op':'overview'},path='/api/modules',host=True,extra={'X-Sundoll-Workspace':'new-workspace'})
        self.assertEqual(code,200,result)


del ModuleHttpTests
