/* Private document controller; all campaign state comes from its owner. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.SundollHostDocuments = { create: factory };
})(typeof globalThis !== 'undefined' ? globalThis : this, function createHostDocuments(dependencies) {
  'use strict';
  const { $, toast, getState, serverApiBase } = dependencies;
// BEGIN DOCUMENT IMPLEMENTATION
/* ==================== 战役资料库（主控台私有） ==================== */

let campaignDocuments = [];
let campaignDocumentsCatalogKey = '';
let campaignDocumentsRequest = 0;
let campaignDocumentsLoading = false;
let campaignDocumentsError = '';
let campaignDocumentSelectedId = '';
let campaignDocumentPreviewId = '';
let campaignDocumentPreviewRequest = 0;

function currentCampaignDocumentsKey() {
  if (!getState().campaignId) return '';
  return `${getState().campaignId}|${getState().campaignName || ''}`;
}

function safeCampaignDocumentEndpoint(raw, prefix, documentId) {
  const expected = `${prefix}${documentId}`;
  const candidate = String(raw || '');
  const relative = candidate === expected || candidate.startsWith(expected + '?') ? candidate : expected;
  return `${serverApiBase()}${relative}`;
}

function normalizeCampaignDocument(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').toLowerCase();
  const type = String(raw.type || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id) || !['docx', 'pdf'].includes(type)) return null;
  const title = String(raw.title || raw.fileName || '未命名资料').trim().slice(0, 200) || '未命名资料';
  const fileName = String(raw.fileName || `${title}.${type}`).trim().slice(0, 240);
  const previewPrefix = type === 'pdf' ? '/api/document-stream/' : '/api/document-preview/';
  return {
    id,
    type,
    title,
    fileName,
    size: Math.max(0, Number(raw.size) || 0),
    mtime: Math.max(0, Number(raw.mtime) || 0),
    previewUrl: safeCampaignDocumentEndpoint(raw.previewUrl, previewPrefix, id),
    downloadUrl: safeCampaignDocumentEndpoint(raw.downloadUrl, '/api/document-download/', id),
  };
}

function formatCampaignDocumentSize(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function campaignDocumentById(documentId = campaignDocumentSelectedId) {
  return campaignDocuments.find((item) => item.id === documentId) || null;
}

function campaignDocumentMeta(documentItem) {
  if (!documentItem) return '';
  return `${documentItem.type.toUpperCase()} · ${formatCampaignDocumentSize(documentItem.size)}`;
}

function setCampaignDocumentStatus(message, kind = '') {
  const status = $('#campaign-document-status');
  const docx = $('#campaign-document-docx');
  const pdf = $('#campaign-document-pdf');
  status.textContent = message;
  status.hidden = false;
  if (kind) status.dataset.state = kind;
  else delete status.dataset.state;
  docx.hidden = true;
  pdf.hidden = true;
}

function clearCampaignDocumentPreview(message = '从左侧选择 Word 或 PDF 文件开始预览。', kind = '') {
  ++campaignDocumentPreviewRequest;
  campaignDocumentPreviewId = '';
  $('#campaign-document-docx').replaceChildren();
  const pdf = $('#campaign-document-pdf');
  pdf.removeAttribute('src');
  setCampaignDocumentStatus(message, kind);
}

function renderCampaignDocumentSelectionHeader() {
  const selected = campaignDocumentById();
  const original = $('#campaign-document-original');
  $('#campaign-document-viewer-title').textContent = selected?.title || '选择一份资料';
  $('#campaign-document-viewer-meta').textContent = selected
    ? `${campaignDocumentMeta(selected)} · ${selected.fileName}`
    : 'Word 会显示为只读页面，PDF 会在这里打开。';
  if (selected) {
    original.href = selected.downloadUrl;
    original.hidden = false;
  } else {
    original.removeAttribute('href');
    original.hidden = true;
  }
}

function makeCampaignDocumentsMessage(text, kind = '') {
  const paragraph = document.createElement('p');
  paragraph.className = 'campaign-documents-empty';
  paragraph.textContent = text;
  if (kind) paragraph.dataset.state = kind;
  return paragraph;
}

function renderCampaignDocumentsUi() {
  const hasCampaign = Boolean(getState().campaignId);
  const selected = campaignDocumentById();
  const count = $('#campaign-documents-count');
  const current = $('#campaign-documents-current');
  const campaignName = $('#campaign-documents-campaign-name');
  const quick = $('#campaign-document-quick-select');
  const list = $('#campaign-documents-list');
  const refreshButtons = [$('#btn-campaign-documents-refresh'), $('#btn-campaign-documents-dialog-refresh')];

  count.textContent = `${campaignDocuments.length} 份`;
  current.textContent = hasCampaign
    ? `当前战役：${getState().campaignName || '未命名战役'}`
    : '选择正式战役后读取 Word / PDF 资料。';
  campaignName.textContent = hasCampaign ? (getState().campaignName || '未命名战役') : '尚未选择战役';
  refreshButtons.forEach((button) => { button.disabled = !hasCampaign || campaignDocumentsLoading; });

  quick.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = campaignDocumentsLoading ? '正在读取资料…'
    : campaignDocumentsError ? '资料读取失败'
      : campaignDocuments.length ? '选择一份资料' : '暂无资料';
  quick.append(placeholder);
  campaignDocuments.forEach((documentItem) => {
    const option = document.createElement('option');
    option.value = documentItem.id;
    option.textContent = `${documentItem.type.toUpperCase()} · ${documentItem.title}`;
    quick.append(option);
  });
  quick.value = selected?.id || '';
  quick.disabled = !hasCampaign || campaignDocumentsLoading || !campaignDocuments.length;
  $('#btn-campaign-document-preview').disabled = !selected || campaignDocumentsLoading;

  list.replaceChildren();
  if (!hasCampaign) {
    list.append(makeCampaignDocumentsMessage('请先选择或新建一个正式战役。'));
  } else if (campaignDocumentsLoading) {
    list.append(makeCampaignDocumentsMessage('正在读取当前战役资料…'));
  } else if (campaignDocumentsError) {
    list.append(makeCampaignDocumentsMessage(campaignDocumentsError, 'error'));
  } else if (!campaignDocuments.length) {
    list.append(makeCampaignDocumentsMessage('当前战役还没有 Word 或 PDF 资料。'));
  } else {
    campaignDocuments.forEach((documentItem) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'campaign-document-item';
      button.dataset.documentId = documentItem.id;
      button.setAttribute('aria-pressed', String(documentItem.id === campaignDocumentSelectedId));
      const title = document.createElement('strong');
      title.textContent = documentItem.title;
      const meta = document.createElement('span');
      meta.textContent = campaignDocumentMeta(documentItem);
      button.append(title, meta);
      button.addEventListener('click', () => selectCampaignDocument(documentItem.id, { open: true, preview: true }));
      list.append(button);
    });
  }
  renderCampaignDocumentSelectionHeader();
}

function selectCampaignDocument(documentId, options = {}) {
  const selected = campaignDocumentById(String(documentId || ''));
  const nextId = selected?.id || '';
  if (nextId !== campaignDocumentSelectedId) {
    campaignDocumentSelectedId = nextId;
    clearCampaignDocumentPreview(selected ? '点击“预览选中文件”读取内容。' : undefined);
  }
  renderCampaignDocumentsUi();
  if (options.open) openCampaignDocumentsDialog();
  if (options.preview && selected) return previewCampaignDocument(selected.id);
  return Promise.resolve(Boolean(selected));
}

function appendCampaignDocumentTextBlock(container, tagName, text, className = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = String(text || '');
  container.append(element);
}

function renderCampaignDocumentBlocks(blocks) {
  const container = $('#campaign-document-docx');
  container.replaceChildren();
  let rendered = 0;
  (Array.isArray(blocks) ? blocks : []).slice(0, 5000).forEach((block) => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, Math.trunc(Number(block.level) || 1)));
      appendCampaignDocumentTextBlock(container, `h${level}`, block.text);
      rendered++;
    } else if (block.type === 'paragraph') {
      appendCampaignDocumentTextBlock(container, 'p', block.text);
      rendered++;
    } else if (block.type === 'list') {
      appendCampaignDocumentTextBlock(container, 'p', block.text, 'document-list-item');
      rendered++;
    } else if (block.type === 'pageBreak') {
      const divider = document.createElement('div');
      divider.className = 'document-page-break';
      divider.setAttribute('aria-hidden', 'true');
      container.append(divider);
      rendered++;
    } else if (block.type === 'table' && Array.isArray(block.rows)) {
      const table = document.createElement('table');
      const body = document.createElement('tbody');
      block.rows.slice(0, 1000).forEach((rawRow) => {
        if (!Array.isArray(rawRow)) return;
        const row = document.createElement('tr');
        rawRow.slice(0, 100).forEach((rawCell) => {
          const cell = document.createElement('td');
          cell.textContent = String(rawCell || '');
          row.append(cell);
        });
        if (row.children.length) body.append(row);
      });
      if (body.children.length) {
        table.append(body);
        container.append(table);
        rendered++;
      }
    }
  });
  return rendered;
}

async function previewCampaignDocument(documentId = campaignDocumentSelectedId) {
  const selected = campaignDocumentById(documentId);
  const requestedKey = currentCampaignDocumentsKey();
  if (!requestedKey || !selected) {
    clearCampaignDocumentPreview(requestedKey ? '请选择一份资料。' : '请先选择或新建一个正式战役。');
    return false;
  }
  campaignDocumentSelectedId = selected.id;
  const request = ++campaignDocumentPreviewRequest;
  campaignDocumentPreviewId = selected.id;
  renderCampaignDocumentsUi();
  setCampaignDocumentStatus(selected.type === 'pdf' ? '正在检查 PDF 预览…' : '正在读取 Word 预览…');
  try {
    if (selected.type === 'pdf') {
      const response = await fetch(selected.previewUrl, { method: 'HEAD', cache: 'no-store' });
      if (request !== campaignDocumentPreviewRequest
        || requestedKey !== currentCampaignDocumentsKey()
        || campaignDocumentSelectedId !== selected.id) return false;
      if (!response.ok) {
        throw new Error(response.status === 404 ? 'PDF 文件不存在，请刷新资料库'
          : response.status === 403 ? '无权读取这份 PDF 资料' : 'PDF 预览读取失败');
      }
      const pdf = $('#campaign-document-pdf');
      pdf.src = selected.previewUrl;
      pdf.hidden = false;
      $('#campaign-document-status').hidden = true;
      return true;
    }

    const response = await fetch(selected.previewUrl, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (request !== campaignDocumentPreviewRequest
      || requestedKey !== currentCampaignDocumentsKey()
      || campaignDocumentSelectedId !== selected.id) return false;
    if (!response.ok || data.ok === false || !Array.isArray(data.document?.blocks)) {
      throw new Error(data.error || 'Word 预览读取失败');
    }
    const rendered = renderCampaignDocumentBlocks(data.document.blocks);
    if (!rendered) {
      setCampaignDocumentStatus('这份 Word 资料没有可显示的文字内容。');
      return true;
    }
    $('#campaign-document-status').hidden = true;
    $('#campaign-document-pdf').hidden = true;
    $('#campaign-document-docx').hidden = false;
    return true;
  } catch (error) {
    if (request !== campaignDocumentPreviewRequest
      || requestedKey !== currentCampaignDocumentsKey()
      || campaignDocumentSelectedId !== selected.id) return false;
    campaignDocumentPreviewId = '';
    setCampaignDocumentStatus('预览失败：' + (error.message || error), 'error');
    return false;
  }
}

async function loadCampaignDocumentLibrary(options = {}) {
  const request = ++campaignDocumentsRequest;
  const requestedKey = currentCampaignDocumentsKey();
  if (!requestedKey) {
    campaignDocumentsCatalogKey = '';
    campaignDocuments = [];
    campaignDocumentsLoading = false;
    campaignDocumentsError = '';
    campaignDocumentSelectedId = '';
    clearCampaignDocumentPreview('请先选择或新建一个正式战役。');
    renderCampaignDocumentsUi();
    return false;
  }

  const campaignChanged = requestedKey !== campaignDocumentsCatalogKey;
  campaignDocumentsCatalogKey = requestedKey;
  campaignDocumentsLoading = true;
  campaignDocumentsError = '';
  if (campaignChanged) {
    campaignDocuments = [];
    campaignDocumentSelectedId = '';
  }
  clearCampaignDocumentPreview('正在读取当前战役资料…');
  renderCampaignDocumentsUi();
  try {
    const query = new URLSearchParams({ campaignId: getState().campaignId || '', campaignName: getState().campaignName || '' });
    const response = await fetch(`${serverApiBase()}/api/document-library?${query}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (request !== campaignDocumentsRequest || requestedKey !== currentCampaignDocumentsKey()) return false;
    if (!response.ok || data.ok === false || !Array.isArray(data.documents)) {
      throw new Error(data.error || '资料库读取失败');
    }
    const previousSelectedId = campaignDocumentSelectedId;
    campaignDocuments = data.documents.map(normalizeCampaignDocument).filter(Boolean);
    campaignDocumentSelectedId = campaignDocuments.some((item) => item.id === previousSelectedId)
      ? previousSelectedId : (campaignDocuments[0]?.id || '');
    campaignDocumentsError = '';
    setCampaignDocumentStatus(campaignDocuments.length
      ? '选择资料后点击预览。'
      : '当前战役还没有 Word 或 PDF 资料。');
    if (!options.silent) toast(`战役资料已刷新：${campaignDocuments.length} 份`);
    return true;
  } catch (error) {
    if (request !== campaignDocumentsRequest || requestedKey !== currentCampaignDocumentsKey()) return false;
    campaignDocuments = [];
    campaignDocumentSelectedId = '';
    campaignDocumentsError = '资料库读取失败：' + (error.message || error);
    setCampaignDocumentStatus(campaignDocumentsError, 'error');
    if (!options.silent) toast(campaignDocumentsError);
    return false;
  } finally {
    if (request === campaignDocumentsRequest && requestedKey === currentCampaignDocumentsKey()) {
      campaignDocumentsLoading = false;
      renderCampaignDocumentsUi();
    }
  }
}

function ensureCampaignDocumentsForCampaign() {
  const key = currentCampaignDocumentsKey();
  if (!key) {
    if (campaignDocumentsCatalogKey || campaignDocuments.length || campaignDocumentsLoading) loadCampaignDocumentLibrary({ silent: true });
    else renderCampaignDocumentsUi();
    return;
  }
  if (key !== campaignDocumentsCatalogKey) loadCampaignDocumentLibrary({ silent: true });
  else renderCampaignDocumentsUi();
}

function openCampaignDocumentsDialog() {
  const dialog = $('#campaign-documents-dialog');
  if (!dialog.open) dialog.showModal();
  renderCampaignDocumentsUi();
}

function closeCampaignDocumentsDialog() {
  $('#campaign-documents-dialog').close();
}

function initCampaignDocumentsUi() {
  const dialog = $('#campaign-documents-dialog');
  if (dialog.dataset.bound === 'true') return;
  dialog.dataset.bound = 'true';
  $('#btn-campaign-documents-refresh').addEventListener('click', () => loadCampaignDocumentLibrary());
  $('#btn-campaign-documents-dialog-refresh').addEventListener('click', () => loadCampaignDocumentLibrary());
  $('#btn-campaign-documents-open').addEventListener('click', openCampaignDocumentsDialog);
  $('#btn-campaign-documents-close').addEventListener('click', closeCampaignDocumentsDialog);
  $('#btn-campaign-document-preview').addEventListener('click', () => {
    openCampaignDocumentsDialog();
    return previewCampaignDocument();
  });
  $('#campaign-document-quick-select').addEventListener('change', (event) => selectCampaignDocument(event.target.value));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
      closeCampaignDocumentsDialog();
    }
  });
  $('#campaign-document-pdf').addEventListener('error', () => {
    if (campaignDocumentPreviewId && campaignDocumentById(campaignDocumentPreviewId)?.type === 'pdf') {
      campaignDocumentPreviewId = '';
      setCampaignDocumentStatus('PDF 预览加载失败，请打开原文件。', 'error');
    }
  });
  renderCampaignDocumentsUi();
}

// END DOCUMENT IMPLEMENTATION
  return Object.freeze({
    init: initCampaignDocumentsUi,
    ensureCampaign: ensureCampaignDocumentsForCampaign,
    refresh: loadCampaignDocumentLibrary,
    select: selectCampaignDocument,
    preview: previewCampaignDocument,
  });
});
