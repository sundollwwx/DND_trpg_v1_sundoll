// Run with node --test tests/test_campaign_documents_ui.cjs. Uses the actual host document UI code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '主控台/app.js'), 'utf8');
const documentsSource = source.slice(
  source.indexOf('/* ==================== 战役资料库（主控台私有）'),
  source.indexOf('/* ==================== 启动 ==================== */'),
);

const ids = [
  'campaign-documents-count', 'campaign-documents-current', 'campaign-document-quick-select',
  'btn-campaign-documents-refresh', 'btn-campaign-document-preview', 'btn-campaign-documents-open',
  'campaign-documents-dialog', 'btn-campaign-documents-close', 'campaign-documents-campaign-name',
  'btn-campaign-documents-dialog-refresh', 'campaign-documents-list', 'campaign-document-viewer-title',
  'campaign-document-viewer-meta', 'campaign-document-original', 'campaign-document-status',
  'campaign-document-docx', 'campaign-document-pdf',
];

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.open = false;
  }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async fire(name, details = {}) {
    const event = { target: this, clientX: 0, clientY: 0, ...details };
    for (const callback of this.listeners[name] || []) await callback(event);
  }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'src' || name === 'href') delete this[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 20, right: 980, top: 20, bottom: 700 }; }
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function fixture(campaignId = '', campaignName = '') {
  const elements = new Map(ids.map((id) => ['#' + id, new Element(id.includes('select') ? 'select' : 'div')]));
  const fetches = [];
  const context = vm.createContext({
    URLSearchParams,
    Number,
    Math,
    state: { campaignId, campaignName },
    serverApiBase: () => 'http://127.0.0.1:8090',
    fetch: async (url) => { fetches.push(String(url)); return response({ ok: true, documents: [] }); },
    toast() {},
    document: { createElement: (tag) => new Element(tag) },
    $: (selector) => {
      assert.ok(elements.has(selector), `known document UI element: ${selector}`);
      return elements.get(selector);
    },
  });
  vm.runInContext(documentsSource, context);
  return { context, elements, fetches, $: (selector) => elements.get(selector), run: (code) => vm.runInContext(code, context) };
}

const docxId = 'a'.repeat(32);
const pdfId = 'b'.repeat(32);
const docxEntry = {
  id: docxId,
  type: 'docx',
  title: '风骸岛手册',
  fileName: '风骸岛手册.docx',
  size: 2048,
  previewUrl: `/api/document-preview/${docxId}?v=1-2`,
  downloadUrl: `/api/document-download/${docxId}?v=1-2`,
};
const pdfEntry = {
  id: pdfId,
  type: 'pdf',
  title: '岛屿地图',
  fileName: '岛屿地图.pdf',
  size: 4096,
  previewUrl: `/api/document-stream/${pdfId}?v=3-4`,
  downloadUrl: `/api/document-download/${pdfId}?v=3-4`,
};

test('empty-campaign state is explicit and every document control is bound', () => {
  const f = fixture();
  f.run('initCampaignDocumentsUi(); ensureCampaignDocumentsForCampaign()');
  assert.equal(f.$('#campaign-documents-count').textContent, '0 份');
  assert.match(f.$('#campaign-documents-current').textContent, /选择正式战役/);
  assert.equal(f.$('#campaign-document-quick-select').disabled, true);
  assert.equal(f.$('#btn-campaign-documents-refresh').disabled, true);
  assert.equal(f.$('#btn-campaign-documents-dialog-refresh').disabled, true);
  for (const selector of [
    '#btn-campaign-documents-refresh', '#btn-campaign-documents-dialog-refresh',
    '#btn-campaign-documents-open', '#btn-campaign-documents-close',
    '#btn-campaign-document-preview', '#campaign-document-quick-select',
  ]) assert.ok(f.$(selector).listeners.click?.length || f.$(selector).listeners.change?.length, `${selector} is bound`);
  assert.ok(f.$('#campaign-documents-dialog').listeners.click?.length);
  assert.ok(f.$('#campaign-document-pdf').listeners.error?.length);
});

test('request token and campaign key prevent a late catalog from replacing the current campaign', async () => {
  const f = fixture('campaign-a', '甲战役');
  const pending = [];
  f.context.fetch = (url) => {
    f.fetches.push(String(url));
    return new Promise((resolve) => pending.push(resolve));
  };
  f.run('initCampaignDocumentsUi()');
  const first = f.run('loadCampaignDocumentLibrary({silent:true})');
  f.context.state.campaignId = 'campaign-b';
  f.context.state.campaignName = '乙战役';
  const second = f.run('loadCampaignDocumentLibrary({silent:true})');
  pending[1](response({ ok: true, documents: [pdfEntry] }));
  await second;
  pending[0](response({ ok: true, documents: [docxEntry] }));
  await first;
  assert.equal(f.run('campaignDocuments.length'), 1);
  assert.equal(f.run('campaignDocuments[0].id'), pdfId);
  assert.equal(f.run('campaignDocumentsCatalogKey'), 'campaign-b|乙战役');
  assert.match(f.fetches[1], /campaignId=campaign-b/);
  assert.match(f.fetches[1], /campaignName=%E4%B9%99%E6%88%98%E5%BD%B9/);
});

test('quick selection checks the PDF endpoint before opening its iframe', async () => {
  const f = fixture('wind-isle', '风骸岛之龙');
  const headRequests = [];
  let finishHead;
  f.context.fetch = (url, options) => {
    if (String(url).includes('/api/document-library?')) return Promise.resolve(response({ ok: true, documents: [docxEntry, pdfEntry] }));
    headRequests.push({ url, options });
    return new Promise((resolve) => { finishHead = resolve; });
  };
  f.run('initCampaignDocumentsUi()');
  await f.run('loadCampaignDocumentLibrary({silent:true})');
  const quick = f.$('#campaign-document-quick-select');
  quick.value = pdfId;
  await quick.fire('change');
  const preview = f.$('#btn-campaign-document-preview').fire('click');
  assert.equal(f.$('#campaign-documents-dialog').open, true);
  assert.equal(f.$('#campaign-document-pdf').hidden, true);
  assert.equal(f.$('#campaign-document-pdf').src, undefined);
  assert.match(f.$('#campaign-document-status').textContent, /正在检查 PDF/);
  assert.equal(headRequests.length, 1);
  assert.equal(headRequests[0].url, `http://127.0.0.1:8090${pdfEntry.previewUrl}`);
  assert.equal(headRequests[0].options.method, 'HEAD');
  assert.equal(headRequests[0].options.cache, 'no-store');
  finishHead({ ok: true, status: 200 });
  await preview;
  assert.equal(f.$('#campaign-document-pdf').hidden, false);
  assert.equal(f.$('#campaign-document-status').hidden, true);
  assert.equal(f.$('#campaign-document-pdf').src, `http://127.0.0.1:8090/api/document-stream/${pdfId}?v=3-4`);
  assert.equal(f.$('#campaign-document-original').href, `http://127.0.0.1:8090/api/document-download/${pdfId}?v=3-4`);
  assert.equal(f.$('#campaign-documents-list').children.length, 2);
});

test('PDF HTTP and network failures leave the iframe hidden and show an error', async (t) => {
  for (const failure of [403, 404, 500, 'network']) {
    await t.test(String(failure), async () => {
      const f = fixture('wind-isle', '风骸岛之龙');
      f.context.fetch = async (url) => {
        if (String(url).includes('/api/document-library?')) return response({ ok: true, documents: [pdfEntry] });
        if (failure === 'network') throw new Error('连接中断');
        return { ok: false, status: failure };
      };
      await f.run('loadCampaignDocumentLibrary({silent:true})');
      assert.equal(await f.run('previewCampaignDocument()'), false);
      assert.equal(f.$('#campaign-document-pdf').hidden, true);
      assert.equal(f.$('#campaign-document-pdf').src, undefined);
      assert.equal(f.$('#campaign-document-status').hidden, false);
      assert.equal(f.$('#campaign-document-status').dataset.state, 'error');
      assert.match(f.$('#campaign-document-status').textContent, /预览失败/);
      assert.equal(f.run('campaignDocumentPreviewId'), '');
    });
  }
});

test('a late PDF HEAD response cannot replace a newer Word selection', async () => {
  const f = fixture('wind-isle', '风骸岛之龙');
  let finishHead;
  f.context.fetch = (url, options) => {
    if (String(url).includes('/api/document-library?')) return Promise.resolve(response({ ok: true, documents: [pdfEntry, docxEntry] }));
    if (options?.method === 'HEAD') return new Promise((resolve) => { finishHead = resolve; });
    return Promise.resolve(response({ ok: true, document: { blocks: [{ type: 'paragraph', text: '当前 Word 内容' }] } }));
  };
  await f.run('loadCampaignDocumentLibrary({silent:true})');
  const previous = f.run('previewCampaignDocument()');
  await f.run(`selectCampaignDocument('${docxId}', {preview:true})`);
  finishHead({ ok: true, status: 200 });
  assert.equal(await previous, false);
  assert.equal(f.$('#campaign-document-pdf').hidden, true);
  assert.equal(f.$('#campaign-document-pdf').src, undefined);
  assert.equal(f.$('#campaign-document-docx').hidden, false);
  assert.equal(f.$('#campaign-document-docx').children[0].textContent, '当前 Word 内容');
  assert.equal(f.run('campaignDocumentPreviewId'), docxId);
});

test('a failed PDF request from an earlier campaign cannot overwrite the new campaign status', async () => {
  const f = fixture('wind-isle', '风骸岛之龙');
  let failHead;
  f.context.fetch = (url) => {
    if (String(url).includes('/api/document-library?')) return Promise.resolve(response({ ok: true, documents: f.context.state.campaignId === 'wind-isle' ? [pdfEntry] : [] }));
    return new Promise((resolve, reject) => { failHead = reject; });
  };
  await f.run('loadCampaignDocumentLibrary({silent:true})');
  const previous = f.run('previewCampaignDocument()');
  f.context.state.campaignId = 'other-campaign';
  await f.run('loadCampaignDocumentLibrary({silent:true})');
  const currentMessage = f.$('#campaign-document-status').textContent;
  failHead(new Error('旧战役连接中断'));
  assert.equal(await previous, false);
  assert.equal(f.$('#campaign-document-status').textContent, currentMessage);
  assert.equal(f.$('#campaign-document-status').dataset.state, undefined);
  assert.equal(f.$('#campaign-document-pdf').src, undefined);
});

test('DOCX preview renders only controlled block types with textContent', async () => {
  const f = fixture('wind-isle', '风骸岛之龙');
  f.context.fetch = async (url) => String(url).includes('/api/document-library?')
    ? response({ ok: true, documents: [docxEntry] })
    : response({ ok: true, document: { id: docxId, type: 'docx', blocks: [
      { type: 'heading', level: 2, text: '第一章' },
      { type: 'paragraph', text: '<img src=x onerror=alert(1)>' },
      { type: 'list', text: '准备补给' },
      { type: 'table', rows: [['地点', '危险'], ['风骸岛', '巨龙']] },
      { type: 'pageBreak' },
      { type: 'script', text: '不能渲染' },
    ] } });
  f.run('initCampaignDocumentsUi()');
  await f.run('loadCampaignDocumentLibrary({silent:true})');
  assert.equal(await f.run('previewCampaignDocument()'), true);
  const blocks = f.$('#campaign-document-docx').children;
  assert.deepEqual(blocks.map((item) => item.tag), ['h2', 'p', 'p', 'table', 'div']);
  assert.equal(blocks[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(blocks[2].className, 'document-list-item');
  assert.equal(blocks[3].children[0].tag, 'tbody');
  assert.equal(blocks[4].className, 'document-page-break');
  assert.equal(f.$('#campaign-document-docx').hidden, false);
  const renderer = documentsSource.slice(
    documentsSource.indexOf('function renderCampaignDocumentBlocks'),
    documentsSource.indexOf('async function previewCampaignDocument'),
  );
  assert.doesNotMatch(renderer, /innerHTML/);
  assert.match(renderer, /textContent/);
});

test('catalog and DOCX errors leave a visible error state', async () => {
  const f = fixture('wind-isle', '风骸岛之龙');
  f.context.fetch = async () => response({ ok: false, error: '读取受限' }, false);
  f.run('initCampaignDocumentsUi()');
  assert.equal(await f.run('loadCampaignDocumentLibrary({silent:true})'), false);
  assert.match(f.$('#campaign-document-status').textContent, /读取受限/);
  assert.equal(f.$('#campaign-document-status').dataset.state, 'error');
  assert.match(f.$('#campaign-documents-list').children[0].textContent, /读取受限/);
});
