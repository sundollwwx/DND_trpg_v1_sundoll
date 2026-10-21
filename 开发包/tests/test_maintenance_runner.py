"""A test run may never inherit the production workspace or mail credential."""
from project_test_paths import TOOLS_ROOT
import importlib.util
import os
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('maintenance_check', TOOLS_ROOT/'maintenance/check_project.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class MaintenanceRunnerTests(unittest.TestCase):
    def test_test_processes_clear_production_overrides(self):
        with mock.patch.dict(os.environ, {'SUNDOLL_WORKSPACE_ROOT':'/must-not-be-used',
                                         'SUNDOLL_SMTP_PASSWORD':'must-not-be-inherited'}), \
                mock.patch('sys.argv', ['check_project.py', '--node', '/test/node']), \
                mock.patch.object(runner.subprocess, 'run', return_value=mock.Mock(returncode=0)) as run:
            self.assertEqual(runner.main(), 0)
        self.assertEqual(len(run.call_args_list), 2)
        for call in run.call_args_list:
            env = call.kwargs['env']
            self.assertNotIn('SUNDOLL_WORKSPACE_ROOT', env)
            self.assertNotIn('SUNDOLL_SMTP_PASSWORD', env)
            self.assertIn('sundoll-check-', env['SUNDOLL_TEST_SAVE_ROOT'])


if __name__ == '__main__':
    unittest.main()
