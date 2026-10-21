"""Machine-private SMTP credentials, independent of portable account backups."""
import contextlib
import os
import secrets
import stat
from pathlib import Path

from . import paths


ERROR_MESSAGE = '邮件服务密钥无法安全读取或保存，请检查本机私有文件权限'
ENV_NAME = 'SUNDOLL_SMTP_PASSWORD'
FILE_NAME = 'resend-api-key'
MAX_SECRET_BYTES = 4096


class MailCredentialError(RuntimeError):
    def __init__(self):
        super().__init__(ERROR_MESSAGE)


def smtp_secret_path():
    """The path is fixed by the installation, never by account settings."""
    return Path(paths.USER_DATA_ROOT) / '联机' / FILE_NAME


def _clean_secret(value, *, allow_empty=False):
    if not isinstance(value, str):
        raise MailCredentialError()
    value = value.strip()
    if (not value and not allow_empty) or any(c in value for c in ('\r', '\n', '\0')):
        raise MailCredentialError()
    if len(value.encode('utf-8')) > MAX_SECRET_BYTES:
        raise MailCredentialError()
    return value


@contextlib.contextmanager
def _credential_directory(*, create=False):
    root = Path(paths.USER_DATA_ROOT)
    if create:
        root.mkdir(parents=True, exist_ok=True)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        root_fd = os.open(root, flags)
    except FileNotFoundError:
        if create:
            raise
        yield None
        return
    directory_fd = None
    try:
        if create:
            try:
                os.mkdir('联机', mode=0o700, dir_fd=root_fd)
            except FileExistsError:
                pass
        try:
            directory_fd = os.open('联机', flags, dir_fd=root_fd)
        except FileNotFoundError:
            if create:
                raise
        yield directory_fd
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        os.close(root_fd)


def read_smtp_secret():
    """Environment wins; a missing or empty private file means unconfigured."""
    try:
        environment = os.environ.get(ENV_NAME, '')
        if environment.strip():
            return _clean_secret(environment)
        # Private files rely on POSIX no-follow opens and owner permissions.
        if os.name != 'posix':
            return ''
        with _credential_directory() as directory_fd:
            if directory_fd is None:
                return ''
            try:
                descriptor = os.open(FILE_NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=directory_fd)
            except FileNotFoundError:
                return ''
            with os.fdopen(descriptor, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or stat.S_IMODE(info.st_mode) & 0o077):
                    raise MailCredentialError()
                value = stream.read(MAX_SECRET_BYTES + 2)
                if len(value) > MAX_SECRET_BYTES + 1:
                    raise MailCredentialError()
                return _clean_secret(value.decode('utf-8'), allow_empty=True)
    except (OSError, UnicodeError, ValueError):
        raise MailCredentialError() from None


def write_smtp_secret(secret):
    """Atomically save a hidden-input credential with owner-only permissions."""
    temporary_name = None
    try:
        value = _clean_secret(secret)
        if os.name != 'posix':
            raise MailCredentialError()
        with _credential_directory(create=True) as directory_fd:
            try:
                current = os.stat(FILE_NAME, dir_fd=directory_fd, follow_symlinks=False)
            except FileNotFoundError:
                current = None
            if current is not None and (not stat.S_ISREG(current.st_mode)
                                        or current.st_uid != os.getuid()):
                raise MailCredentialError()
            temporary_name = '.' + FILE_NAME + '.' + secrets.token_hex(12) + '.tmp'
            descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=directory_fd)
            try:
                with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    stream.write(value + '\n')
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary_name, FILE_NAME, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
                temporary_name = None
            finally:
                if temporary_name is not None:
                    with contextlib.suppress(OSError):
                        os.unlink(temporary_name, dir_fd=directory_fd)
        return smtp_secret_path()
    except (OSError, UnicodeError, ValueError):
        raise MailCredentialError() from None
