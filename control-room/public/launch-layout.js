// Bind the precomposed launch page; original quote, wallet and transaction handlers keep ownership.
(() => {
  const byId = id => document.getElementById(id);
  const left = byId('left');
  const cols = document.querySelector('.mh-launch-page .cols');
  const quote = document.querySelector('.quote');
  const intro = document.querySelector('.mh-launch-intro');
  const dialog = byId('launchFirstBuy');
  const identity = byId('name')?.closest('.card');
  const nav = document.querySelector('.create-nav');
  const panels = [byId('create-step-0'), byId('create-step-1')];
  const tokenPreview = document.querySelector('.token-preview');
  const actions = document.querySelector('.create-actions');
  const statusArea = document.querySelector('.create-status');
  const status = byId('status');
  const buyActions = byId('buyActions');
  const buyStatus = byId('buyStatus');
  const buyClose = byId('buyClose');
  const buyConnect = byId('buyConnect');
  if (!left || !cols || !quote || !intro || !dialog || !identity || !nav ||
      panels.some(panel => !panel) || !tokenPreview || !actions || !statusArea ||
      !buyActions || !buyStatus || !buyClose || !buyConnect) return;
  // Stable HTML supplies the first paint, step visibility and original control
  // locations. Only the network switch may arrive later from its existing API.
  const logoFileInput = byId('logoFile');
  const logoUrlInput = byId('logo');
  const fieldCounters = ['name', 'symbol', 'description'].map(id => ({input: byId(id), count: byId(id + 'Count')}));
  for (const button of nav.querySelectorAll('button')) button.onclick = () => show(Number(button.dataset.step), true);
  buyConnect.onclick = () => {
    if (!busy() && dialog.open) byId('connect')?.click();
  };
  const solanaSvg = '<svg viewBox="0 0 40 40" aria-hidden="true"><path fill="#65DBC8" d="m11 7-7 7h25l7-7H11Z"/><path fill="#79AADF" d="m4 17 7 7h25l-7-7H4Z"/><path fill="#AB81EE" d="m11 27-7 7h25l7-7H11Z"/></svg>';
  const robinhoodSvg = '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m9 33 5-17L29 6l5 5-10 16-15 6Z" fill="#35CB77"/><path d="m7 35 21-23m-13 7 3 5 8-1m-8-9 5 3 1-7" stroke="#103D25" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const checkSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m7.5 12 3 3 6-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let step = 0;
  let complete = false;
  let returnFocus = null;
  let stepMotion = null;
  let syncing = false;
  const busy = () => Boolean(window.GatewayLaunchBusy);
  const isSolana = () => (window.GatewayLaunchVenue?.get?.() || (document.body.classList.contains('mh-solana') ? 'pump' : 'pons')) === 'pump';
  const setText = (element, value) => { if (element && element.textContent !== value) element.textContent = value; };
  const setHidden = (element, hidden) => { if (element && element.hidden !== hidden) element.hidden = hidden; };
  const setDisabled = (element, disabled) => { if (element && element.disabled !== disabled) element.disabled = disabled; };

  const logoImage = byId('tokenLogoPreview');
  const logoPlaceholder = byId('tokenPreviewPlaceholder');
  const logoStatus = byId('tokenLogoStatus');
  const logoFrame = tokenPreview.querySelector('.token-preview-image');
  const imageActions = tokenPreview.querySelector('.token-image-actions');
  const avatarImages = [byId('tokenAvatarImage'), byId('aiTokenLogo')];
  let logoObjectUrl = null;
  let previewFile = null;
  let renderedLogoSource = null;
  let committedLogoUrl = logoUrlInput?.value.trim() || '';
  let logoLoadVersion = 0;
  const allowedLogoTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const failedLogoFiles = new WeakSet();
  const failedLogoUrls = new Set();
  const preparedLogoFiles = new WeakSet();
  const logoPreparationErrors = new WeakMap();
  let logoPrepareVersion = 0, logoPreparing = false, preparingFile = null;

  function releaseLogoObjectUrl() {
    if (logoObjectUrl) URL.revokeObjectURL(logoObjectUrl);
    logoObjectUrl = null;
    previewFile = null;
  }

  function publicLogoPreviewUrl(value) {
    if (value.length > 2048) throw new Error('Use an HTTPS or IPFS image URL.');
    if (value.startsWith('ipfs://')) {
      const match = /^ipfs:\/\/([^/?#]+)(?:\/([^?#]*))?$/.exec(value);
      const cid = match?.[1] || '';
      const path = match?.[2] || '';
      if (!(/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})$/.test(cid)) ||
          path && path.split('/').some(segment => !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segment))) {
        throw new Error('Use a valid IPFS image URL.');
      }
      return `https://ipfs.io/ipfs/${cid}${path ? '/' + path : ''}`;
    }
    let url;
    try { url = new URL(value); } catch { throw new Error('Use an HTTPS or IPFS image URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS or IPFS image URL.');
    return url.href;
  }

  function fieldProblem(input, required) {
    const value = input.value.trim();
    const limit = Number(input.getAttribute('maxlength')) || Infinity;
    if (required && value.length < 2) return 'Enter at least 2 characters.';
    if (value.length > limit) return `Use at most ${limit} characters.`;
    return '';
  }

  // Decode only bounded raster bytes. Filenames and browser MIME labels are not
  // evidence of image type; the resulting real PNG File keeps the original
  // transaction reader and its 500 KB request limit unchanged.
  function logoSourceProblem(file) {
    if (!file) return 'Add a logo image.';
    if (!Number.isFinite(file.size) || file.size <= 0) return 'Choose a non-empty image.';
    if (file.size > 10 * 1024 * 1024) return 'Choose an image of 10 MB or less.';
    return '';
  }

  function rasterLogoInfo(bytes) {
    const b = bytes, ascii = (start, count) => String.fromCharCode(...b.slice(start, start + count));
    const u16 = at => b[at] | b[at + 1] << 8, u24 = at => u16(at) | b[at + 2] << 16;
    let type, width, height;
    if (b.length >= 24 && ascii(1, 3) === 'PNG' && b[0] === 137 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) {
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      type = 'image/png';width = view.getUint32(16);height = view.getUint32(20);
    } else if (b.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
      type = 'image/gif';width = u16(6);height = u16(8);
    } else if (b.length >= 25 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      type = 'image/webp';
      if (ascii(12, 4) === 'VP8X' && b.length >= 30) {width = 1 + u24(24);height = 1 + u24(27);}
      else if (ascii(12, 4) === 'VP8L' && b[20] === 47) {width = 1 + (b[21] | (b[22] & 63) << 8);height = 1 + ((b[22] >> 6) | b[23] << 2 | (b[24] & 15) << 10);}
      else if (ascii(12, 4) === 'VP8 ' && b.length >= 30 && b[23] === 157 && b[24] === 1 && b[25] === 42) {width = u16(26) & 16383;height = u16(28) & 16383;}
    } else if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
      type = 'image/jpeg';
      for (let at = 2; at < b.length;) {
        if (b[at++] !== 255) break;
        while (b[at] === 255) at++;
        const marker = b[at++];
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || marker >= 208 && marker <= 216) continue;
        if (at + 2 > b.length) break;
        const length = b[at] * 256 + b[at + 1];
        if (length < 2 || at + length > b.length) break;
        if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
          height = b[at + 3] * 256 + b[at + 4];width = b[at + 5] * 256 + b[at + 6];break;
        }
        at += length;
      }
    }
    if (!type || !width || !height) throw new Error('Choose a valid PNG, JPG, GIF or WebP image.');
    if (width > 16384 || height > 16384 || width * height > 16_777_216) throw new Error('Choose an image up to 16 megapixels.');
    return { type, width, height };
  }

  async function decodeRasterLogo(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await new Promise((resolve, reject) => {
          let expired = false;
          const timer = setTimeout(() => {expired = true;reject(new Error('Image preparation timed out. Try another file.'));}, 10000);
          createImageBitmap(blob).then(image => {clearTimeout(timer);if (expired) image.close();else resolve(image);}, error => {clearTimeout(timer);reject(error);});
        });
      } catch { /* Safari may support a raster format through Image instead. */ }
    }
    return await new Promise((resolve, reject) => {
      const image = new Image(), source = URL.createObjectURL(blob);
      const release = () => {clearTimeout(timer);image.onload = image.onerror = null;URL.revokeObjectURL(source);};
      const timer = setTimeout(() => {release();image.src = '';reject(new Error('Image preparation timed out. Try another file.'));}, 10000);
      image.onload = () => {release();resolve(image);};
      image.onerror = () => {release();reject(new Error('Could not read this image. Choose another file.'));};
      image.src = source;
    });
  }

  async function optimizeLogoFile(file) {
    const problem = logoSourceProblem(file);
    if (problem) throw new Error(problem);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Choose a non-empty image of 10 MB or less.');
    const info = rasterLogoInfo(bytes);
    const image = await decodeRasterLogo(new Blob([bytes], {type: info.type}));
    try {
      const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
      if (!width || !height || width * height > 16_777_216) throw new Error('Choose an image up to 16 megapixels.');
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not prepare the image. Try another browser.');
      for (const size of [512, 384, 256, 192, 128]) {
        const scale = Math.min(1, size / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));canvas.height = Math.max(1, Math.round(height * scale));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (blob && blob.size > 0 && blob.size <= 500 * 1024) return new File([blob], 'project-logo.png', {type: 'image/png'});
      }
      throw new Error('Could not reduce this image. Choose a simpler logo.');
    } finally { image.close?.(); }
  }

  async function prepareSelectedLogo() {
    if (complete) return;
    const file = logoFileInput?.files?.[0];
    if (file && file === preparingFile && logoPreparing) return;
    const version = ++logoPrepareVersion;
    preparingFile = file;logoPreparing = false;
    if (!file || preparedLogoFiles.has(file)) {renderTokenLogo();refreshDialog();return;}
    const problem = logoSourceProblem(file);
    if (problem) {logoPreparationErrors.set(file, problem);renderTokenLogo();refreshDialog();return;}
    logoPreparing = true;renderTokenLogo();refreshDialog();
    try {
      const normalized = await optimizeLogoFile(file);
      if (version !== logoPrepareVersion || complete || logoFileInput?.files?.[0] !== file) return;
      if (typeof DataTransfer !== 'function') throw new Error('Your browser could not prepare the upload. Try another browser.');
      const transfer = new DataTransfer();transfer.items.add(normalized);
      logoFileInput.files = transfer.files;
      const assigned = logoFileInput.files?.[0];
      if (!assigned || assigned.size !== normalized.size || assigned.type !== 'image/png') throw new Error('Your browser could not prepare the upload. Try another browser.');
      preparedLogoFiles.add(assigned);logoPreparing = false;preparingFile = assigned;
      logoFileInput.setCustomValidity('');
      logoFileInput.dispatchEvent(new Event('input', {bubbles: true}));
      logoFileInput.dispatchEvent(new Event('change', {bubbles: true}));
    } catch (error) {
      if (version !== logoPrepareVersion || complete) return;
      logoPreparing = false;
      logoPreparationErrors.set(logoFileInput?.files?.[0] || file, error?.message || 'Could not prepare this image. Try another file.');
      renderTokenLogo();refreshDialog();
    }
  }

  function logoFileProblem(file) {
    if (!file) return 'Add a logo image.';
    if (logoPreparing && file === preparingFile) return 'Preparing logo…';
    if (logoPreparationErrors.has(file)) return logoPreparationErrors.get(file);
    if (!preparedLogoFiles.has(file)) return 'Choose an image to prepare its logo.';
    if (!allowedLogoTypes.has(file.type)) return 'Choose a PNG, JPG, GIF or WebP image.';
    if (!Number.isFinite(file.size) || file.size <= 0) return 'Choose a non-empty image.';
    if (file.size > 500 * 1024) return 'Choose an image of 500 KB or less.';
    if (failedLogoFiles.has(file)) return 'Could not read this image. Choose another file.';
    return '';
  }

  function urlLogoProblem() {
    const value = logoUrlInput?.value.trim();
    if (!value) return '';
    try { return failedLogoUrls.has(publicLogoPreviewUrl(value)) ? 'Could not load this image. Try another URL.' : ''; }
    catch (error) { return error.message; }
  }

  function updateTokenReadiness() {
    const detailsReady = ['name', 'symbol', 'description'].every(id => !fieldProblem(byId(id), id !== 'description'));
    const solana = isSolana();
    const imageReady = solana ? !logoFileProblem(logoFileInput?.files?.[0]) : !urlLogoProblem();
    byId('tokenReadyDetails').dataset.ready = String(detailsReady);
    byId('tokenReadyImage').dataset.ready = String(imageReady);
    setText(byId('tokenReadyImage'), solana ? 'Coin image' : 'Coin image (optional)');
    byId('tokenReadyDetails').setAttribute('aria-label', `Coin details: ${detailsReady ? 'ready' : 'incomplete'}`);
    byId('tokenReadyImage').setAttribute('aria-label', `Coin image${solana ? '' : ' (optional)'}: ${imageReady ? 'ready' : 'incomplete'}`);
  }

  function syncVenueControls() {
    const sw = byId('venuePump')?.closest('.venue-switch');
    if (sw && sw.parentElement !== identity) identity.querySelector('h2').after(sw);
    if (sw) setText(sw.querySelector('.venue-label'), 'Network');
    const linksLabel = byId('logoLinksSummary')?.firstChild;
    if (linksLabel?.nodeType === 3) setText(linksLabel, 'Add links ');
    setText(byId('logoLinksHint'), '(optional)');
    for (const [id, network, platform, svg] of [['venuePump', 'Solana', 'pump.fun', solanaSvg], ['venuePons', 'Robinhood', 'Pons', robinhoodSvg]]) {
      const button = byId(id);
      if (!button || button.dataset.decorated === 'true') continue;
      button.innerHTML = `<span class="token-venue-icon">${svg}</span><span class="token-venue-copy"><b>${network}</b><small>${platform}</small></span><span class="token-venue-check">${checkSvg}</span>`;
      button.setAttribute('aria-label', `${network} · ${platform}`);
      button.dataset.decorated = 'true';
    }
    const solana = isSolana(), network = solana ? 'Solana' : 'Robinhood';
    const networkLabel = byId('tokenPreviewNetwork');
    if (networkLabel.dataset.venue !== (solana ? 'pump' : 'pons')) {
      networkLabel.innerHTML = `${solana ? solanaSvg : robinhoodSvg}<span>${network}</span>`;
      networkLabel.dataset.venue = solana ? 'pump' : 'pons';
    }
    setText(byId('aiTokenNetwork'), solana ? 'Solana · pump.fun' : 'Robinhood · Pons');
    setText(byId('tokenImagePrompt'), solana ? 'Add a logo' : 'Enter logo URL');
    setText(byId('tokenImageInstruction'), solana ? 'Choose a file or drop it here' : 'Add an HTTPS or IPFS image below');
    setHidden(byId('tokenImageLimits'), true);
    setText(byId('tokenLogoFormats'), solana ? 'PNG, JPG, GIF, WebP · up to 10 MB · auto-optimized' : 'Optional · HTTPS or IPFS');
    logoFrame.dataset.droppable = String(solana);
  }

  function updateTokenPreviewText() {
    const name = byId('name').value.trim();
    const symbol = byId('symbol').value.trim().toUpperCase();
    for (const id of ['tokenPreviewName', 'aiTokenName']) setText(byId(id), name || 'Your project');
    for (const id of ['tokenPreviewSymbol', 'aiTokenSymbol']) setText(byId(id), symbol ? '$' + symbol : '$SYMBOL');
    setText(byId('tokenPreviewDescription'), byId('description').value.trim() || 'Your description will appear here.');
    logoImage.setAttribute('alt', (name || 'Project') + ' logo');
    for (const { input, count } of fieldCounters) {
      const limit = input.getAttribute('maxlength');
      setText(count, `${input.value.length}${limit ? '/' + limit : ''}`);
    }
    updateTokenReadiness();
  }

  function renderTokenLogo() {
    if (complete) return;
    const solana = isSolana();
    updateTokenReadiness();
    tokenPreview.dataset.logoSource = solana ? 'file' : 'url';
    let source = '', error = '';
    if (solana) {
      const file = logoFileInput?.files?.[0];
      if (file !== previewFile) releaseLogoObjectUrl();
      if (file) {
        error = logoFileProblem(file);
        if (!error) {
          try {
            if (!logoObjectUrl) { logoObjectUrl = URL.createObjectURL(file); previewFile = file; }
            source = logoObjectUrl;
          } catch { error = 'Image preview is unavailable.'; }
        }
      }
    } else if (committedLogoUrl) {
      try { source = publicLogoPreviewUrl(committedLogoUrl); }
      catch (cause) { error = cause.message; }
    }
    if (source && source === renderedLogoSource && !error && !logoStatus.textContent) return;
    renderedLogoSource = source;
    const version = ++logoLoadVersion;
    const sourceFile = solana ? logoFileInput?.files?.[0] : null;
    const focusedImageAction = imageActions.contains(document.activeElement);
    logoImage.hidden = true;
    imageActions.hidden = true;
    logoPlaceholder.hidden = false;
    setHidden(byId('tokenLogoAdd'), false);
    if (focusedImageAction && !busy() && !dialog.open && !panels[0].hidden) byId('tokenLogoAdd').focus({ preventScroll: true });
    for (const image of avatarImages) {image.hidden = true;image.removeAttribute('src');image.parentElement.classList.remove('has-logo');}
    tokenPreview.classList.remove('has-logo');
    setText(logoStatus, error);
    logoStatus.hidden = !error;
    logoFrame.removeAttribute('aria-busy');
    logoImage.onload = null;
    logoImage.onerror = null;
    if (!source) { logoImage.removeAttribute('src'); return; }
    logoFrame.setAttribute('aria-busy', 'true');
    logoImage.onload = () => {
      if (version !== logoLoadVersion || complete) return;
      const focusedAdd = document.activeElement === byId('tokenLogoAdd');
      logoFrame.removeAttribute('aria-busy');
      logoImage.hidden = false;
      logoPlaceholder.hidden = true;
      tokenPreview.classList.add('has-logo');
      if (sourceFile) failedLogoFiles.delete(sourceFile);
      else failedLogoUrls.delete(source);
      updateTokenReadiness();
      imageActions.hidden = false;
      setHidden(byId('tokenLogoAdd'), true);
      if (focusedAdd && !busy() && !dialog.open && !panels[0].hidden) byId('tokenImageChange').focus({ preventScroll: true });
      for (const image of avatarImages) {image.setAttribute('src', source);image.hidden = false;image.parentElement.classList.add('has-logo');}
      setText(logoStatus, '');
      logoStatus.hidden = true;
    };
    logoImage.onerror = () => {
      if (version !== logoLoadVersion || complete) return;
      logoFrame.removeAttribute('aria-busy');
      if (sourceFile) failedLogoFiles.add(sourceFile);
      else failedLogoUrls.add(source);
      updateTokenReadiness();
      setText(logoStatus, 'Could not load this image.');
      logoStatus.hidden = false;
    };
    logoImage.setAttribute('src', source);
  }

  function moveOriginalControls() {
    // Pump may finish loading before or after this layout. Moving the controls
    // preserves the exact onclick handlers and all existing disabled checks.
    for (const id of ['launch', 'pumpLaunch']) {
      const button = byId(id);
      if (button && button.parentElement !== buyActions) buyActions.append(button);
    }
    const pumpStatus = byId('pumpStatus');
    if (pumpStatus && pumpStatus.parentElement !== statusArea) {
      pumpStatus.setAttribute('role', 'status');
      statusArea.append(pumpStatus);
    }
  }

  function purchaseFeedback(solana) {
    const input = byId(solana ? 'firstBuySol' : 'firstBuy');
    if (!input) return '';
    const currency = solana ? 'SOL' : 'ETH';
    if (input.validity?.badInput) return `Enter a valid ${currency} amount.`;
    if (Number(input.value) < 0) return `Enter 0 or a positive ${currency} amount.`;
    if (solana) {
      try { window.GatewayLaunchPurchase.parseSol(input.value); }
      catch (error) { return error.message; }
    }
    const invalid = input.validity ? !input.validity.valid : !input.checkValidity();
    return invalid ? input.validationMessage || `Enter a valid ${currency} amount.` : '';
  }

  function refreshDialog() {
    if (syncing || complete) return;
    syncing = true;
    moveOriginalControls();
    const solana = isSolana();
    const original = byId(solana ? 'pumpLaunch' : 'launch');
    const needsWallet = Boolean(original?.disabled && /^connect wallet/i.test(original.textContent.trim()));
    const working = busy();
    for (const id of ['launch', 'pumpLaunch']) {
      const button = byId(id);
      if (button) button.classList.toggle('buy-wallet-required', button === original && needsWallet);
    }
    setHidden(buyConnect, !needsWallet);
    setDisabled(buyConnect, working || Boolean(byId('connect')?.disabled));
    setDisabled(buyClose, working);
    dialog.classList.toggle('buy-pending', working);
    if (working) dialog.setAttribute('aria-busy', 'true');
    else dialog.removeAttribute('aria-busy');
    setText(byId('buyContext'), solana ? 'pump.fun · Solana' : 'Pons · Robinhood Chain');
    setText(byId('pumpFirstBuyAmount'), purchaseFeedback(true) ? '—' : byId('firstBuySol')?.value.trim() || '0');
    const symbol = byId('symbol').value.trim().toUpperCase();
    const title = byId('buyTitle');
    const titleLabel = symbol ? `Buy $${symbol} ` : 'Initial buy ';
    if (title?.firstChild?.nodeType === 3 && title.firstChild.textContent !== titleLabel) title.firstChild.textContent = titleLabel;
    setText(byId('firstBuyHelp'), solana ? 'Buy limit includes trading fees; unused SOL stays in your wallet. Enter 0 to skip.' : 'Enter 0 to skip the initial buy.');
    const fee = byId('qFee')?.textContent.trim();
    setText(byId('buyCosts'), (solana ? 'Network and account fees apply.' : fee && !fee.includes('…') ? `Launch fee: ${fee}. Network fees apply.` : 'Launch and network fees apply.') + ' Separate from AI funding.');
    const activeStatus = solana ? byId('pumpStatus') : status;
    if (dialog.open) {
      const amountError = purchaseFeedback(solana);
      const message = amountError || activeStatus?.textContent.trim() || '';
      setText(buyStatus, message);
      buyStatus.className = 'buy-status' + (amountError || activeStatus?.classList.contains('bad') ? ' bad' : activeStatus?.classList.contains('ok') ? ' ok' : '');
      setHidden(buyStatus, !message);
    }
    for (const button of nav.querySelectorAll('button')) setDisabled(button, working);
    setDisabled(byId('createBack'), working);
    setDisabled(byId('createNext'), working || isSolana() && logoPreparing);
    for (const id of ['tokenLogoAdd', 'tokenImageChange', 'tokenImageRemove', 'aiTokenEdit']) setDisabled(byId(id), working);
    syncing = false;
  }

  function validIdentity() {
    for (const id of ['name', 'symbol', 'description']) {
      const element = byId(id);
      element.setCustomValidity(fieldProblem(element, id !== 'description'));
      if (!element.reportValidity()) return false;
    }
    const logo = isSolana() ? logoFileInput : logoUrlInput;
    const error = isSolana() ? logoFileProblem(logoFileInput?.files?.[0]) : urlLogoProblem();
    if (logo) {
      logo.setCustomValidity(error);
      if (error) {
        setText(logoStatus, error);logoStatus.hidden = false;
        logo.focus();logo.reportValidity();
        updateTokenReadiness();
        return false;
      }
    }
    return true;
  }

  function show(next, focus) {
    if (complete || busy() || !Number.isInteger(next) || next < 0 || next > 1) return;
    if (next > 0 && !validIdentity()) return;
    step = next;
    const actionPanel = step === 0 ? identity : panels[1];
    if (actions.parentElement !== actionPanel) actionPanel.append(actions);
    byId('createNextHint').hidden = step !== 0;
    panels.forEach((panel, index) => { panel.hidden = index !== step; });
    nav.querySelectorAll('button').forEach((button, index) => {
      if (index === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    byId('createBack').hidden = step === 0;
    byId('createNext').textContent = step === 0 ? 'Choose AI' : 'Review launch';
    cols.classList.toggle('is-ai-setup', step === 1);
    stepMotion?.cancel();
    if (focus) {
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced && panels[step].animate) stepMotion = panels[step].animate([{ opacity: .7, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 160, easing: 'ease-out' });
      panels[step].focus({ preventScroll: true });
      if (nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: 'start', behavior: reduced ? 'instant' : 'smooth' });
    }
  }

  function openBuy() {
    if (complete || busy() || dialog.open) return;
    if (!validIdentity()) { show(0, true); return; }
    const model = byId('model');
    model.setCustomValidity(model.value ? '' : 'Choose an AI model.');
    if (!model.reportValidity()) return;
    if (!document.querySelector('#stock tr.pick.on')) {
      if (status) { status.textContent = 'Choose a computer.'; status.className = 'hint bad'; }
      byId('stock').querySelector('button')?.focus();
      return;
    }
    if (quote.dataset.quoteState !== 'ready') {
      quote.focus({ preventScroll: true });
      quote.scrollIntoView({ block: 'nearest' });
      return;
    }
    returnFocus = document.activeElement;
    refreshDialog();
    dialog.showModal();
    refreshDialog();
    const amount = byId(isSolana() ? 'firstBuySol' : 'firstBuy');
    amount?.focus();
    amount?.select();
  }

  function closeBuy() {
    if (!busy() && dialog.open) dialog.close();
  }
  buyClose.onclick = closeBuy;
  dialog.addEventListener('cancel', event => { if (busy()) event.preventDefault(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) closeBuy(); });
  dialog.addEventListener('close', () => {
    if (returnFocus?.isConnected && !complete) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  });
  byId('createBack').onclick = () => show(0, true);
  byId('aiTokenEdit').onclick = () => show(0, true);
  byId('createNext').onclick = () => step === 0 ? show(1, true) : openBuy();
  for (const id of ['name', 'symbol', 'description', 'model', 'logoFile', 'logo', 'firstBuy', 'firstBuySol']) {
    byId(id)?.addEventListener('input', () => { byId(id).setCustomValidity(''); refreshDialog(); });
  }
  for (const id of ['name', 'symbol', 'description', 'logo']) byId(id).addEventListener('input', updateTokenPreviewText);
  logoFileInput?.addEventListener('input', prepareSelectedLogo);
  logoFileInput?.addEventListener('change', prepareSelectedLogo);
  logoUrlInput?.addEventListener('change', () => {
    committedLogoUrl = logoUrlInput.value.trim();
    renderTokenLogo();
  });
  const chooseLogo = () => {
    if (busy() || complete) return;
    if (isSolana()) logoFileInput?.click();
    else { logoUrlInput?.focus();logoUrlInput?.select(); }
  };
  byId('tokenLogoAdd').onclick = chooseLogo;
  byId('tokenImageChange').onclick = chooseLogo;
  byId('tokenImageRemove').onclick = () => {
    if (busy() || complete) return;
    const input = isSolana() ? logoFileInput : logoUrlInput;
    if (!input) return;
    input.value = '';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  };
  for (const type of ['dragenter', 'dragover']) logoFrame.addEventListener(type, event => {
    if (!isSolana() || busy() || complete) return;
    event.preventDefault();logoFrame.classList.add('is-dragover');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  logoFrame.addEventListener('dragleave', event => {
    if (!event.relatedTarget || !logoFrame.contains(event.relatedTarget)) logoFrame.classList.remove('is-dragover');
  });
  logoFrame.addEventListener('drop', event => {
    event.preventDefault();logoFrame.classList.remove('is-dragover');
    if (!isSolana() || busy() || complete) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    const error = files.length > 1 ? 'Choose one image.' : logoSourceProblem(files[0]);
    if (error) {setText(logoStatus, error);logoStatus.hidden = false;return;}
    try {
      const transfer = new DataTransfer();transfer.items.add(files[0]);
      logoFileInput.files = transfer.files;
      logoFileInput.dispatchEvent(new Event('input', {bubbles: true}));
      logoFileInput.dispatchEvent(new Event('change', {bubbles: true}));
    } catch {setText(logoStatus, 'Use Choose file to add this image.');logoStatus.hidden = false;}
  });
  document.addEventListener('autonom:launch-venue', () => {
    byId('logoFile')?.setCustomValidity('');
    committedLogoUrl = logoUrlInput?.value.trim() || '';
    syncVenueControls();updateTokenPreviewText();
    renderTokenLogo();
    refreshDialog();
  });
  window.addEventListener('pagehide', () => {
    releaseLogoObjectUrl();
    renderedLogoSource = null;
    ++logoLoadVersion;
    ++logoPrepareVersion;logoPreparing = false;preparingFile = null;
  });
  window.addEventListener('pageshow', prepareSelectedLogo);

  const controlObserver = new MutationObserver(refreshDialog);
  controlObserver.observe(buyActions, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'], characterData: true });
  const connection = byId('connect');
  if (connection) controlObserver.observe(connection, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'], characterData: true });
  controlObserver.observe(statusArea, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  const fee = byId('qFee');
  if (fee) controlObserver.observe(fee, { childList: true, subtree: true, characterData: true });
  // The original success renderer owns #left. Close the dialog and remove step
  // navigation when it replaces the form; never reconstruct a completed form.
  const completion = new MutationObserver(() => {
    if (left.contains(panels[0])) return;
    complete = true;
    releaseLogoObjectUrl();
    if (dialog.open) dialog.close();
    nav.hidden = true;
    actions.hidden = true;
    intro.hidden = true;
    left.hidden = false;
    cols.classList.add('is-complete');
    controlObserver.disconnect();
    completion.disconnect();
  });
  completion.observe(left, { childList: true });
  syncVenueControls();
  updateTokenPreviewText();
  renderTokenLogo();
  refreshDialog();
  show(0, false);
})();
