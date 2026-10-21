'use strict';
const form = document.querySelector('#dm-login-form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button'), input = document.querySelector('#dm-password');
  const error = document.querySelector('#dm-login-error');
  if (button.disabled) return;
  button.disabled = true; error.textContent = '正在登录…';
  try {
    const response = await fetch('/api/dm/login', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({password: input.value}), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '登录失败，请重试');
    input.value = '';
    location.replace('/主控台/主控台.html');
  } catch (issue) {
    error.textContent = issue.name === 'TimeoutError' ? '连接超时，请稍后重试' : issue.message || '暂时无法连接服务';
  } finally { button.disabled = false; }
});
