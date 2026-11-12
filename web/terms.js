// 公开条款页只读取服务端当前文案；不读取账号、空间或任何成员数据。
const API = '/functions/v1/app';

function fillParagraphs(container, text) {
  container.replaceChildren();
  const sentences = String(text ?? '').match(/[^。]+。?/g) ?? [];
  let count = 0;
  for (const sentence of sentences) {
    const value = sentence.trim();
    if (!value) continue;
    const p = document.createElement('p');
    p.textContent = value;
    container.append(p);
    count += 1;
  }
  if (count === 0 && text) {
    const p = document.createElement('p');
    p.textContent = text;
    container.append(p);
  }
}

function showFailure(message) {
  const status = document.getElementById('terms-status');
  status.textContent = message;
  status.className = 'inline-error';
}

async function loadTerms() {
  let body = null;
  try {
    const response = await fetch(`${API}/api/notice`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch {
    showFailure('条款正文暂时无法读取，请稍后重试；已登录用户仍可在空间内查看告知。');
    return;
  }
  if (!body || typeof body !== 'object') {
    showFailure('条款正文格式异常，请稍后重试。');
    return;
  }
  const general = Array.isArray(body.general) ? body.general : [];
  const list = document.getElementById('terms-general');
  list.replaceChildren();
  for (const item of general) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  fillParagraphs(document.getElementById('terms-join'), body.text);
  fillParagraphs(document.getElementById('terms-calendar'), body.calendar?.text);
  fillParagraphs(document.getElementById('terms-share'), body.share?.text);
  document.getElementById('terms-status').hidden = true;
  document.getElementById('terms-content').hidden = false;
}

document.getElementById('terms-back').addEventListener('click', (event) => {
  event.preventDefault();
  if (history.length > 1) history.back();
  else location.href = './index.html';
});

void loadTerms();
