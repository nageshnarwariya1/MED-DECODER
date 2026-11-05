const $ = (selector) => document.querySelector(selector);
let selectedFile = null;
let activeReport = null;
const supported = new Set(['application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv']);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function show(el, visible = true) { el.classList.toggle('hidden', !visible); }
function setError(message) { const node = $('#upload-error'); node.textContent = message; show(node, Boolean(message)); }
function fileSize(bytes) { return bytes < 1024*1024 ? `${(bytes/1024).toFixed(0)} KB` : `${(bytes/1024/1024).toFixed(1)} MB`; }
function setFile(file) {
  setError('');
  if (!file) { selectedFile = null; show($('#selected-file'), false); $('#analyze-btn').disabled = true; return; }
  if (!supported.has(file.type)) { setError('Unsupported format. Please choose PDF, JPG/JPEG, PNG, WEBP, TXT or CSV.'); selectedFile = null; show($('#selected-file'), false); $('#analyze-btn').disabled = true; return; }
  if (file.size > 15 * 1024 * 1024) { setError('This file is larger than 15 MB. Please compress it or choose a smaller copy.'); selectedFile = null; show($('#selected-file'), false); $('#analyze-btn').disabled = true; return; }
  selectedFile = file;
  $('#file-name').textContent = file.name;
  $('#file-meta').textContent = `${fileSize(file.size)} · Ready to analyse`;
  $('#report-file').value = '';
  show($('#selected-file'));
  $('#analyze-btn').disabled = !$('#privacy-consent').checked;
}
async function optimizeImageForUpload(file) {
  if (!file.type.startsWith('image/') || file.size < 2 * 1024 * 1024) return file;
  if (typeof createImageBitmap !== 'function') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 2600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      bitmap.close?.();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      bitmap.close?.();
      return file;
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob || blob.size >= file.size) return file;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'lab-report';
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (error) {
    console.warn('Image optimization skipped:', error.message);
    return file;
  }
}

$('#report-file').addEventListener('change', e => setFile(e.target.files[0]));
$('#privacy-consent').addEventListener('change', () => { $('#analyze-btn').disabled = !selectedFile || !$('#privacy-consent').checked; });
$('#remove-file').addEventListener('click', () => setFile(null));
$('#drop-zone').addEventListener('dragover', e => { e.preventDefault(); $('#drop-zone').classList.add('dragover'); });
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('dragover'));
$('#drop-zone').addEventListener('drop', e => { e.preventDefault(); $('#drop-zone').classList.remove('dragover'); setFile(e.dataTransfer.files[0]); });

async function checkStatus() {
  try {
    const r = await fetch('/api/health');
    const data = await r.json();
    if (!data.aiConfigured) {
      const note = document.createElement('div');
      note.className = 'alert';
      note.style.cssText = 'background:#fff8e9;border:1px solid #f2e0b8;color:#866628;margin-top:14px;font-size:11px';
      note.textContent = 'Live AI is not configured on this server yet. You can explore the sample report, but real uploads need the site owner to configure the AI key.';
      $('#upload-form').after(note);
    }
  } catch { /* Local page can still show the sample if the API is not running. */ }
}
checkStatus();

$('#upload-form').addEventListener('submit', async e => {
  e.preventDefault();
  setError('');
  if (!selectedFile) return setError('Please choose a report file first.');
  if (!$('#privacy-consent').checked) return setError('Please read and accept the privacy notice before continuing.');
  $('#analyze-btn').disabled = true;
  show($('#loading-state'));
  const loadingTitle = $('#loading-state b');
  const loadingMessage = $('#loading-state p');
  try {
    if (selectedFile.type.startsWith('image/') && selectedFile.size >= 2 * 1024 * 1024) {
      loadingTitle.textContent = 'Optimizing the image…';
      loadingMessage.textContent = 'Reducing the image size while keeping report text readable.';
    }
    const uploadFile = await optimizeImageForUpload(selectedFile);
    loadingTitle.textContent = 'AI is reading your report…';
    loadingMessage.textContent = 'Checking visible test values and the reference ranges printed on the report. Multi-page PDFs may take longer.';
    const form = new FormData();
    form.append('report', uploadFile);
    form.append('language', $('#language-select').value);
    form.append('consent', 'yes');
    if (uploadFile !== selectedFile) {
      $('#file-meta').textContent = `${fileSize(selectedFile.size)} → ${fileSize(uploadFile.size)} · Optimized for upload`;
    }
    const response = await fetch('/api/analyze', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not analyse this report.');
    activeReport = data.report;
    renderReport(activeReport);
    show($('#results-section'));
    $('#results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setError(error.message || 'Something went wrong. Please try again.');
  } finally {
    loadingTitle.textContent = 'Reading your report…';
    loadingMessage.textContent = 'Checking the text, values and reference ranges. This can take a little time for large reports.';
    show($('#loading-state'), false);
    $('#analyze-btn').disabled = !selectedFile || !$('#privacy-consent').checked;
  }
});

const sampleReport = {
  id: 'sample-report', isSample: true, fileName: 'Sample_Kidney_Function_Report.pdf', reportType: 'Kidney function (sample)', language: 'en',
  confidence: null,
  summary: 'This sample shows a few kidney-function test values. Two values are above the reference ranges printed in this example. This does not confirm a kidney disease. A doctor needs to interpret these results along with symptoms, medicines, hydration and previous reports.',
  keyFindings: ['Creatinine is above this sample report’s reference range.', 'Urea is slightly above the sample range.', 'The estimated GFR value is below the sample range and should be discussed with a clinician.'],
  tests: [
    {name:'Serum Creatinine',value:'1.8',unit:'mg/dL',referenceRange:'0.7 – 1.3 mg/dL',status:'high',explanation:'Creatinine is a waste product filtered by the kidneys. This sample value is higher than the range printed here.',confidence:98},
    {name:'Blood Urea',value:'48',unit:'mg/dL',referenceRange:'15 – 40 mg/dL',status:'high',explanation:'Urea is a waste product carried in the blood. This sample value is above the printed range.',confidence:96},
    {name:'eGFR',value:'58',unit:'mL/min/1.73m²',referenceRange:'Above 60 mL/min/1.73m²',status:'low',explanation:'eGFR is an estimate of how well the kidneys filter blood. One result alone cannot establish a diagnosis.',confidence:92},
    {name:'Sodium',value:'139',unit:'mmol/L',referenceRange:'135 – 145 mmol/L',status:'normal',explanation:'Sodium helps regulate fluid balance. This sample result is within the printed range.',confidence:97}
  ],
  questionsForDoctor:['How should these kidney-function values be interpreted together with my previous reports and symptoms?','Do I need a repeat kidney-function test or a urine albumin test, and when?','Could dehydration, recent illness or any of my current medicines affect these results?'],
  medicineQuestions:['Do any of my current medicines affect kidney function?','Should I avoid or review any over-the-counter pain medicines? Please explain what is safe for me.'],
  dietQuestions:['Should I make any changes to salt, protein or fluid intake based on my complete medical history?','Do I need advice from a renal dietitian, and are there foods I should limit?'],
  nextStepQuestions:['When should I repeat these tests?','What symptoms should prompt me to contact a healthcare professional sooner?'],
  limitations:['This is synthetic sample data for demonstrating the website. It is not a real patient report or medical advice.']
};
$('#sample-btn').addEventListener('click', () => {
  activeReport = structuredClone(sampleReport);
  renderReport(activeReport);
  show($('#results-section'));
  $('#results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#new-report-btn').addEventListener('click', () => {
  activeReport = null;
  setFile(null);
  $('#privacy-consent').checked = false;
  $('#language-select').value = 'en';
  show($('#results-section'), false);
  $('#upload-section').scrollIntoView({ behavior: 'smooth' });
});
$('#print-btn').addEventListener('click', () => window.print());

function statusText(status) { return ({high:'High',low:'Low',normal:'Within range',review:'Check'}[status] || 'Check'); }
function renderReport(report) {
  $('#result-title').textContent = report.isSample ? 'Sample report — see how it works' : `${report.reportType || 'Your report'} explained`;
  $('#result-file-name').textContent = report.isSample ? 'Sample data only · Not a real patient report' : `File: ${report.fileName || 'Uploaded report'}`;
  $('#confidence-number').textContent = report.confidence === null || report.confidence === undefined || report.confidence === '' ? '—' : (Number.isFinite(Number(report.confidence)) ? Math.round(report.confidence) : '—');
  $('#report-summary').textContent = report.summary || 'No summary was returned. Please check the individual test values.';
  $('#key-findings').innerHTML = (report.keyFindings || []).map(x => `<li>${esc(x)}</li>`).join('');
  const tests = report.tests || [];
  const high = tests.filter(t => t.status === 'high').length;
  const low = tests.filter(t => t.status === 'low').length;
  const review = tests.filter(t => t.status === 'review').length;
  $('#quick-stats').innerHTML = `
    <div class="stat-card stat-high"><strong>${high + low}</strong><span>Outside printed range</span></div>
    <div class="stat-card"><strong>${tests.length}</strong><span>Tests read</span></div>
    <div class="stat-card stat-review"><strong>${review}</strong><span>Need manual checking</span></div>`;
  $('#test-rows').innerHTML = tests.map(t => `<tr>
    <td>${esc(t.name)}</td><td>${esc(t.value)} ${esc(t.unit)}</td><td>${esc(t.referenceRange || 'Not read')}</td>
    <td><span class="status-pill status-${esc(t.status || 'review')}">${statusText(t.status)}</span></td><td>${esc(t.explanation || 'Please compare with the original report.')}${t.possibleMeaning ? `<small class=\"test-context\">Context: ${esc(t.possibleMeaning)}</small>` : ''}</td>
  </tr>`).join('');
  fillList('#doctor-questions', report.questionsForDoctor);
  fillList('#medicine-questions', report.medicineQuestions);
  fillList('#diet-questions', report.dietQuestions);
  fillList('#next-questions', report.nextStepQuestions);
  const limitations = report.limitations || [];
  $('#limitations-list').innerHTML = limitations.map(x => `<li>${esc(x)}</li>`).join('');
  show($('#limitations-box'), limitations.length > 0);
  $('#report-chat-messages').innerHTML = '<div class="chat-bubble assistant-bubble">Hello! I can explain the terms and values in this report. I cannot diagnose or prescribe, but I can help you prepare questions for your doctor.</div>';
}
function fillList(selector, values) {
  $(selector).innerHTML = (values || []).map(x => `<li>${esc(x)}</li>`).join('');
}

function appendMessage(container, message, type) {
  const item = document.createElement('div');
  item.className = `chat-bubble ${type === 'user' ? 'user-bubble' : 'assistant-bubble'}`;
  item.textContent = message;
  container.appendChild(item);
  container.scrollTop = container.scrollHeight;
  return item;
}
async function askAssistant(message, container, language, context, mode) {
  const pending = appendMessage(container, 'Thinking…', 'assistant');
  try {
    const response = await fetch('/api/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, language, reportContext: context, mode })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI assistant is unavailable.');
    pending.textContent = data.reply;
  } catch (error) { pending.textContent = error.message; }
  container.scrollTop = container.scrollHeight;
}
$('#report-chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#report-chat-input');
  const message = input.value.trim();
  if (!message || !activeReport) return;
  input.value = '';
  appendMessage($('#report-chat-messages'), message, 'user');
  await askAssistant(message, $('#report-chat-messages'), activeReport.language || $('#language-select').value, activeReport, 'report');
});
$('#support-toggle').addEventListener('click', () => show($('#support-panel')));
$('#support-close').addEventListener('click', () => show($('#support-panel'), false));
$('#support-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#support-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  appendMessage($('#support-messages'), message, 'user');
  await askAssistant(message, $('#support-messages'), $('#language-select').value, activeReport, activeReport ? 'report' : 'support');
});
