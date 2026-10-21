#!/usr/bin/env python3
"""Offline account-room setup, configuration checks and legacy invitations.

Copy 邮箱账号设置.example.json to the private auth directory reported by `check`.
Set SUNDOLL_SMTP_PASSWORD in the server's environment, or use set-smtp-secret
to save a machine-private credential; never put it in command arguments.
Enabling the configuration switches public player login to email on
the next planned service restart. It does not grant campaign or DM permissions.
"""
import argparse
from contextlib import closing
import getpass
import json
import os
import re
import sys
import warnings
from pathlib import Path
from urllib.parse import urlsplit
from server import paths
from server.email_accounts import AccountStore, AccountError, email_key, read_settings
from server.player_profiles import Store, ProfileError, LOCK
from server.mail_credentials import MailCredentialError, write_smtp_secret


class AccountArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # A mistakenly pasted key must not be repeated in argparse diagnostics.
        if 'set-smtp-secret' in sys.argv[1:]:
            message = '发信密钥请在隐藏输入提示中填写，不能作为命令参数'
        super().error(message)


def initialize_accounts(save_root, origin, smtp):
    """Initialize an empty installation without creating a legacy game database."""
    from server.installation_backup import InstallationLease, _safe_path
    from server.save_storage import ProjectServerLock
    from server.storage_mode import ARCHIVE_FILE, MODE_FILE, FORMAT
    from server.workspace import atomic_json
    save = Path(save_root).expanduser().absolute()
    if save.name != '存档' or save.parent.name != '运行数据' or '..' in save.parts:
        raise ValueError('初始化目录必须是 新安装/运行数据/存档')
    root, data = save.parent.parent, save.parent
    _safe_path(root, save)
    if (root/ARCHIVE_FILE).exists():
        raise ValueError('历史归档不能初始化为日常服务')
    try:
        url = urlsplit(str(origin).strip())
        if (url.scheme != 'https' or not url.hostname or url.username or url.password
                or url.path not in ('', '/') or url.query or url.fragment
                or any(character.isspace() for character in url.netloc)
                or url.port not in (None, 443)
                or not re.fullmatch(r'[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?', url.hostname)):
            raise ValueError()
    except ValueError:
        raise ValueError('请提供本站账号服务的 HTTPS 域名地址，使用默认 443 端口，不含路径或登录信息') from None
    smtp = dict(smtp)
    if smtp.get('security') not in ('ssl', 'starttls') or not 1 <= smtp.get('port', 0) <= 65535:
        raise ValueError('SMTP 加密方式或端口无效')
    configured = [bool(smtp.get(field)) for field in ('host', 'username', 'from')]
    if any(configured) and not all(configured):
        raise ValueError('SMTP 主机、用户名、发件邮箱需要一起填写，也可以暂时全部留空')
    if all(configured):
        if any(character.isspace() for character in smtp['host']) or '/' in smtp['host']:
            raise ValueError('SMTP 主机只填写域名或 IP 地址')
        if len(smtp['username']) > 512 or any(ord(c) < 32 for c in smtp['username']):
            raise ValueError('SMTP 用户名无效')
        smtp['from'] = email_key(smtp['from'])
    settings = dict(enabled=True, roomsEnabled=True, publicOrigin='https://'+url.netloc, smtp=smtp)
    marker = dict(format=4, workspace='../..', storageMode='account-rooms')
    mode = dict(format=FORMAT)
    marker_path, mode_path = save/'工作区.json', data/MODE_FILE
    network_path = data/'联机设置.json'
    network = dict(webEntrances=dict(playerHostname=url.hostname), launcher=dict(openBrowser=False))
    config_path = data/'认证/邮箱账号设置.json'
    with closing(InstallationLease(root)), closing(ProjectServerLock(save)):
        # Permit only our exact incomplete first-install marker. Existing
        # configuration, data or legacy modules are never reset by "init".
        permitted = {'.安装维护.lock', '存档', '存档/.server.lock', '认证'}
        expected = {marker_path: marker, mode_path: mode, network_path: network}
        for file, value in expected.items():
            if file.exists():
                if not file.is_file() or json.loads(file.read_text('utf-8')) != value:
                    raise ValueError('安装已有配置或存档，初始化不会覆盖；请使用维护或迁移流程')
                permitted.add(file.relative_to(data).as_posix())
        for path in data.rglob('*'):
            _safe_path(root, path)
            if path.relative_to(data).as_posix() not in permitted:
                raise ValueError('安装已有配置或存档，初始化不会覆盖；请使用维护或迁移流程')
        for name in ('通用包', '战役包', '玩家包'):
            folder = _safe_path(root, root/name)
            if folder.exists() and (not folder.is_dir() or any(folder.iterdir())):
                raise ValueError('安装包含旧工作区内容，请先备份并明确迁移，不能直接初始化')
        created = []
        try:
            # A crash after the marker fails closed: startup requires both the
            # mode flag and enabled settings. Re-running init can finish it.
            for file, value in ((marker_path, marker), (mode_path, mode),
                                (network_path, network), (config_path, settings)):
                if file.exists():
                    continue
                atomic_json(file, value)
                created.append(file)
                file.chmod(0o600)
            config_path.parent.chmod(0o700)
        except BaseException:
            for file in reversed(created):
                file.unlink(missing_ok=True)
            raise
    return dict(initialized=True, configPath=str(config_path), storageMode='account-rooms',
                smtpConfigured=all(configured), emailDeliveryVerified=False,
                message='账号房间配置已建立；请配置发信密钥后启动服务。未创建账号、未发送邮件。',
                accountPath='/account#dashboard')


def main():
    parser = AccountArgumentParser(description='账号房间初始化、配置检查与旧工作区兼容维护')
    parser.add_argument('--save-root', default=str(paths.SAVE_ROOT), help='存档根目录，默认为本项目正式目录')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check', help='只读检查配置，不发送邮件、不修改账号')
    sub.add_parser('players', help='仅旧工作区：列出尚未迁移的玩家编号')
    sub.add_parser('set-smtp-secret', help='以隐藏输入保存本机发信密钥，不发送邮件、不启用账号')
    initialize = sub.add_parser('init', help='仅为空安装建立账号房间配置，不覆盖已有存档；不发送邮件')
    initialize.add_argument('--origin', required=True, help='自己的账号服务 HTTPS 地址，如 https://play.example.com')
    initialize.add_argument('--smtp-host', default='')
    initialize.add_argument('--smtp-port', type=int, default=465)
    initialize.add_argument('--smtp-security', choices=('ssl', 'starttls'), default='ssl')
    initialize.add_argument('--smtp-user', default='')
    initialize.add_argument('--smtp-from', default='')
    invite = sub.add_parser('invite', help='为指定邮箱和现有玩家生成有效期一天的绑定链接')
    invite.add_argument('--email', required=True)
    invite.add_argument('--player-id', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'init':
            result = initialize_accounts(args.save_root, args.origin, dict(
                host=args.smtp_host, port=args.smtp_port, security=args.smtp_security,
                username=args.smtp_user, **{'from': args.smtp_from}))
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        if args.command == 'set-smtp-secret':
            if os.name != 'posix':
                parser.exit(1, '此系统请使用 SUNDOLL_SMTP_PASSWORD 环境变量配置发信密钥；私有密钥文件仅支持 macOS/Linux\n')
            try:
                with warnings.catch_warnings():
                    # Never fall back to visible input in a non-interactive shell.
                    warnings.simplefilter('error', getpass.GetPassWarning)
                    secret = getpass.getpass('请粘贴 Resend API key（输入不会显示）：')
                path = write_smtp_secret(secret)
            except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
                parser.exit(1, '请在本机交互终端中填写隐藏的发信密钥\n')
            print(json.dumps({'saved': True, 'secretPath': str(path),
                              'message': '本机发信密钥已保存，未发送邮件、未启用账号',
                              'restartRequiredAfterConfiguration': True}, ensure_ascii=False, indent=2))
            return
        profiles = Store(args.save_root,paths.APP_ROOT,paths.ASSET_ROOT)
        settings = read_settings(profiles.auth_root)
        from server.workspace_backup import epoch
        accounts = AccountStore(profiles.auth_root,settings,epoch=lambda:epoch(args.save_root))
        if args.command == 'check':
            from server.storage_mode import account_rooms_only
            result = {'configPath':str(profiles.auth_root/'邮箱账号设置.json'),
                      'enabled':accounts.enabled,'emailReady':bool(accounts.mailer.ready),
                      'roomsEnabled':settings.get('roomsEnabled') is True,
                      'storageMode':'account-rooms' if account_rooms_only(args.save_root) else 'workspace',
                      'publicOrigin':str(settings.get('publicOrigin') or ''),
                      'passwordSource':'SUNDOLL_SMTP_PASSWORD environment variable, then machine-private resend-api-key file',
                      'restartRequiredAfterConfiguration':True}
        elif args.command == 'players':
            if settings.get('roomsEnabled') is True:
                raise AccountError('账号房间模式不使用旧玩家档案，请在个人主页管理角色')
            result = {'players':[{'playerId':p['playerId'],'name':p['name'],'enabled':p.get('enabled',False)} for p in profiles.players()]}
        else:
            if not accounts.enabled: raise AccountError('请先完成邮箱账号配置')
            if settings.get('roomsEnabled') is True: raise AccountError('多战役模式不使用全局玩家绑定，请通过账号中心邀请战役成员')
            with LOCK: token = accounts.invite(args.email,args.player_id,profiles)
            result = {'url':settings['publicOrigin'].rstrip('/')+'/account#bind='+token,
                      'message':'此链接仅限指定邮箱登录后使用，有效期一天。请交给对应玩家；不会自动发送邮件。'}
        print(json.dumps(result,ensure_ascii=False,indent=2))
    except (AccountError,ProfileError,MailCredentialError,RuntimeError,OSError,ValueError) as error:
        parser.exit(1,str(error)+'\n')


if __name__ == '__main__': main()
