
(function () {
  'use strict';

  var FORMATS = [
    { id: 'webp', mime: 'image/webp', ext: 'webp', label: 'WebP (recommended)', lossy: true },
    { id: 'avif', mime: 'image/avif', ext: 'avif', label: 'AVIF (smallest)', lossy: true },
    { id: 'jpeg', mime: 'image/jpeg', ext: 'jpg', label: 'JPEG', lossy: true },
    { id: 'png', mime: 'image/png', ext: 'png', label: 'PNG (lossless)', lossy: false }
  ];
  // Safari and some phones refuse canvases larger than this many pixels.
  var SAFE_AREA = 16777216;

  var settings = { format: 'webp', mode: 'quality', quality: 80, target: 200, size: 'original', maxw: 1920 };
  var items = [];
  var queue = Promise.resolve();
  var nextId = 1;

  var $ = function (id) { return document.getElementById(id); };
  var formatSel = $('format');

  function fmt(id) { return FORMATS.filter(function (f) { return f.id === id; })[0]; }

  function bn(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function size(bytes) {
    if (bytes >= 1048576) { return bn((bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)) + ' MB'; }
    return bn(Math.max(1, Math.round(bytes / 1024))) + ' KB';
  }

  function canvasBlob(canvas, mime, quality) {
    return new Promise(function (resolve) {
      try { canvas.toBlob(function (b) { resolve(b); }, mime, quality); } catch (e) { resolve(null); }
    });
  }

  /* Which formats can this browser actually write? */
  function detectFormats() {
    var c = document.createElement('canvas');
    c.width = c.height = 2;
    c.getContext('2d').fillRect(0, 0, 2, 2);
    return Promise.all(FORMATS.map(function (f) {
      return canvasBlob(c, f.mime, 0.8).then(function (b) { f.ok = !!b && b.type === f.mime; });
    }));
  }

  function fillFormats() {
    formatSel.innerHTML = '';
    FORMATS.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.ok ? f.label : f.label + ' — not supported in this browser';
      o.disabled = !f.ok;
      formatSel.appendChild(o);
    });
    if (!fmt(settings.format).ok) { settings.format = 'jpeg'; }
    formatSel.value = settings.format;
    syncFormat();
  }

  function syncFormat() {
    var f = fmt(settings.format);
    var lossy = f.lossy;
    $('quality').disabled = !lossy;
    document.querySelector('[data-mode="target"]').disabled = !lossy;
    if (!lossy && settings.mode === 'target') { setMode('quality'); }
    $('format-hint').textContent = {
      webp: 'Stays sharp even at very few KB.',
      avif: 'Even smaller than WebP, but slower to create.',
      jpeg: 'Works everywhere; safe for Facebook and LinkedIn.',
      png: 'No quality loss, so heavy for photos. Good for logos and screenshots.'
    }[f.id];
  }

  function setMode(mode) {
    settings.mode = mode;
    document.querySelectorAll('[data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); });
    $('quality-box').hidden = mode !== 'quality';
    $('target-box').hidden = mode !== 'target';
  }

  function setSize(s) {
    settings.size = s;
    document.querySelectorAll('[data-size]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.size === s)); });
    $('max-box').hidden = s !== 'max';
    $('size-hint').hidden = s !== 'original';
  }

  /* ---- Reading an image -------------------------------------------- */

  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return createImageBitmap(file);
      }).catch(function () { return decodeWithImg(file); });
    }
    return decodeWithImg(file);
  }

  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  /* ---- Making one smaller copy ------------------------------------- */

  function draw(src, srcW, srcH, w, h, mime) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (!ctx) { return null; }
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, w, h);
    return canvas;
  }

  function encode(canvas, f, s) {
    if (!f.lossy) { return canvasBlob(canvas, f.mime); }
    if (s.mode === 'quality') { return canvasBlob(canvas, f.mime, s.quality / 100); }

    // The KB target is a ceiling: start from the chosen quality and only
    // go lower when needed, never higher (higher only adds weight).
    var limit = s.target * 1024;
    var lo = 0.05, hi = s.quality / 100, best = null, smallest = null;
    var step = function (i) {
      if (i >= 8) { return Promise.resolve(best || smallest); }
      var q = (lo + hi) / 2;
      return canvasBlob(canvas, f.mime, q).then(function (b) {
        if (!b) { return best || smallest; }
        if (!smallest || b.size < smallest.size) { smallest = b; }
        if (b.size <= limit) { best = b; lo = q; } else { hi = q; }
        return step(i + 1);
      });
    };
    return canvasBlob(canvas, f.mime, hi).then(function (b) {
      if (b && b.size <= limit) { return b; }
      if (b) { smallest = b; }
      return step(0);
    });
  }

  function process(item) {
    var s = Object.assign({}, settings);
    var f = fmt(s.format);
    item.state = 'busy';
    item.note = '';
    item.error = '';
    render(item);

    var decoded;
    return decode(item.file).then(function (d) {
      decoded = d;
      var src = d.source || d;
      var w0 = d.width, h0 = d.height;
      item.srcW = w0;
      item.srcH = h0;
      var w = w0, h = h0;

      if (s.size === 'max' && s.maxw > 0 && w > s.maxw) {
        h = Math.max(1, Math.round(h * s.maxw / w));
        w = s.maxw;
      }

      var tryDraw = function (w1, h1) {
        var c = draw(src, w0, h0, w1, h1, f.mime);
        if (!c) { return Promise.resolve(null); }
        return encode(c, f, s).then(function (b) {
          c.width = c.height = 0;
          return b ? { blob: b, w: w1, h: h1 } : null;
        });
      };

      return tryDraw(w, h).then(function (r) {
        if (r || w * h <= SAFE_AREA) { return r; }
        // The browser could not hold the full picture: retry at the largest size it allows.
        var k = Math.sqrt(SAFE_AREA / (w * h));
        item.note = 'This image is larger than the browser can handle, so the resolution was reduced a little.';
        return tryDraw(Math.floor(w * k), Math.floor(h * k));
      });
    }).then(function (r) {
      if (!r) { throw new Error('encode'); }
      if (r.blob.type !== f.mime) { item.note = 'This browser could not create ' + f.ext.toUpperCase() + '.'; }
      if (s.mode === 'target' && r.blob.size > s.target * 1024) {
        item.note = 'Could not get under ' + bn(s.target) + ' KB even at the lowest quality. Try a smaller max width.';
      }
      if (item.outUrl) { URL.revokeObjectURL(item.outUrl); }
      item.out = r.blob;
      item.outUrl = URL.createObjectURL(r.blob);
      item.outW = r.w;
      item.outH = r.h;
      item.ext = f.ext;
      item.state = 'done';
    }).catch(function (e) {
      item.state = 'error';
      item.error = e && e.message === 'decode'
        ? 'The browser cannot open this image (for example iPhone HEIC). Export it to another format first.'
        : 'Could not compress. The image may be too large for this device\'s memory; try "Max width".';
    }).then(function () {
      if (decoded) {
        if (decoded.close) { decoded.close(); }
        if (decoded.url) { URL.revokeObjectURL(decoded.url); }
      }
      render(item);
      summary();
    });
  }

  function enqueue(item) {
    queue = queue.then(function () { return items.indexOf(item) >= 0 ? process(item) : null; });
  }

  /* ---- Showing the list -------------------------------------------- */

  function outName(item) {
    return item.file.name.replace(/\.[^.]+$/, '') + '.' + item.ext;
  }

  function render(item) {
    var el = item.el;
    if (!el) {
      el = item.el = document.createElement('div');
      el.className = 'card item';
      $('list').appendChild(el);
    }
    var head = '<div class="name" title="' + esc(item.file.name) + '">' + esc(item.file.name) + '</div>';
    var thumb, body, actions = '';

    if (item.state === 'done') {
      var pct = Math.round(100 - 100 * item.out.size / item.file.size);
      var badge = pct > 0
        ? '<span class="badge good">' + bn(pct) + '% smaller</span>'
        : '<span class="badge warn">' + bn(-pct) + '% larger</span>';
      thumb = '<img class="thumb" src="' + item.outUrl + '" alt="" data-compare="' + item.id + '" title="Compare before and after">';
      body = head +
        '<div class="line">' + size(item.file.size) + ' → <b>' + size(item.out.size) + '</b>' + badge + '</div>' +
        '<div class="line">' + bn(item.outW) + ' × ' + bn(item.outH) + ' px · ' + item.ext.toUpperCase() +
        (item.outW !== item.srcW ? ' (original ' + bn(item.srcW) + ' × ' + bn(item.srcH) + ')' : '') + '</div>' +
        (item.note ? '<div class="note">' + esc(item.note) + '</div>' : '') +
        (pct <= 0 ? '<div class="note">The original was already lighter; you may want to keep it.</div>' : '');
      actions = '<a class="btn small primary" href="' + item.outUrl + '" download="' + esc(outName(item)) + '">Download</a>' +
        '<button class="btn small" type="button" data-compare="' + item.id + '">Compare</button>';
    } else if (item.state === 'error') {
      thumb = '<span class="thumb empty"></span>';
      body = head + '<div class="err">' + esc(item.error) + '</div>';
    } else {
      thumb = '<span class="thumb empty"></span>';
      body = head + '<div class="line">' + size(item.file.size) + ' · ' + (item.state === 'busy' ? 'Compressing…' : 'Waiting') + '</div>' +
        (item.state === 'busy' ? '<div class="bar"><i></i></div>' : '');
    }
    actions += '<button class="btn small" type="button" data-remove="' + item.id + '">Remove</button>';
    el.innerHTML = thumb + '<div class="meta">' + body + '</div><div class="item-actions">' + actions + '</div>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function summary() {
    var done = items.filter(function (i) { return i.state === 'done'; });
    var busy = items.some(function (i) { return i.state === 'busy' || i.state === 'wait'; });
    $('toolbar').hidden = items.length === 0;
    $('empty').hidden = items.length > 0;
    $('zip').disabled = done.length === 0 || busy;
    $('redo').disabled = busy || items.length === 0;
    if (!done.length) {
      $('summary').innerHTML = busy ? 'Compressing…' : '';
      return;
    }
    var before = done.reduce(function (a, i) { return a + i.file.size; }, 0);
    var after = done.reduce(function (a, i) { return a + i.out.size; }, 0);
    var pct = Math.round(100 - 100 * after / before);
    $('summary').innerHTML = bn(done.length) + (done.length === 1 ? ' image: ' : ' images: ') + size(before) + ' → <b>' + size(after) + '</b> ' +
      (pct > 0 ? '<span class="saved">(' + bn(pct) + '% saved)</span>' : '') +
      (busy ? ' · the rest are in progress…' : '');
  }

  function add(files) {
    Array.prototype.forEach.call(files, function (file) {
      if (file.type && file.type.indexOf('image/') !== 0) { return; }
      var item = { id: nextId++, file: file, state: 'wait' };
      items.push(item);
      render(item);
      enqueue(item);
    });
    summary();
  }

  function remove(id) {
    var item = items.filter(function (i) { return i.id === id; })[0];
    if (!item) { return; }
    items.splice(items.indexOf(item), 1);
    if (item.outUrl) { URL.revokeObjectURL(item.outUrl); }
    item.el.remove();
    summary();
  }

  /* ---- Download all ------------------------------------------------ */

  function downloadAll() {
    var done = items.filter(function (i) { return i.state === 'done'; });
    if (!window.JSZip) {
      // No internet for the zip library: download one by one instead.
      done.forEach(function (i, n) {
        setTimeout(function () {
          var a = document.createElement('a');
          a.href = i.outUrl; a.download = outName(i); document.body.appendChild(a); a.click(); a.remove();
        }, n * 300);
      });
      return;
    }
    var zip = new JSZip();
    var used = {};
    done.forEach(function (i) {
      var name = outName(i);
      var base = name.replace(/\.[^.]+$/, ''), ext = name.slice(base.length), n = 2;
      while (used[name.toLowerCase()]) { name = base + '-' + n++ + ext; }
      used[name.toLowerCase()] = true;
      zip.file(name, i.out);
    });
    var btn = $('zip');
    btn.disabled = true;
    btn.textContent = 'Building ZIP…';
    zip.generateAsync({ type: 'blob', compression: 'STORE' }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'optimized-images.zip'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }).then(function () {
      btn.textContent = 'Download all (ZIP)';
      summary();
    });
  }

  /* ---- Before / after ---------------------------------------------- */

  var beforeUrl = null;

  function openCompare(id) {
    var item = items.filter(function (i) { return i.id === id; })[0];
    if (!item || item.state !== 'done') { return; }
    beforeUrl = URL.createObjectURL(item.file);
    $('cmp-before').src = beforeUrl;
    $('cmp-after').src = item.outUrl;
    $('dlg-title').textContent = item.file.name + ' · ' + size(item.file.size) + ' → ' + size(item.out.size);
    $('cmp-tag-after').textContent = item.ext.toUpperCase() + ' · ' + size(item.out.size);
    setSplit(50);
    $('dlg').showModal();
  }

  function setSplit(p) {
    p = Math.max(0, Math.min(100, p));
    $('cmp-after-box').style.clipPath = 'inset(0 0 0 ' + p + '%)';
    $('cmp-handle').style.left = p + '%';
  }

  function closeCompare() {
    $('dlg').close();
  }

  $('dlg').addEventListener('close', function () {
    if (beforeUrl) { URL.revokeObjectURL(beforeUrl); beforeUrl = null; }
    $('cmp-before').removeAttribute('src');
  });

  var cmp = $('cmp');
  var dragging = false;
  function moveTo(e) {
    var r = cmp.getBoundingClientRect();
    setSplit((e.clientX - r.left) / r.width * 100);
  }
  cmp.addEventListener('pointerdown', function (e) { dragging = true; cmp.setPointerCapture(e.pointerId); moveTo(e); });
  cmp.addEventListener('pointermove', function (e) { if (dragging) { moveTo(e); } });
  cmp.addEventListener('pointerup', function () { dragging = false; });
  $('dlg-close').addEventListener('click', closeCompare);

  /* ---- Wiring ------------------------------------------------------ */

  var drop = $('drop');
  drop.addEventListener('click', function () { $('file').click(); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  $('file').addEventListener('change', function () { add(this.files); this.value = ''; });
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) { add(e.dataTransfer.files); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  document.addEventListener('paste', function (e) {
    var files = Array.prototype.map.call(e.clipboardData ? e.clipboardData.items : [], function (i) { return i.getAsFile(); }).filter(Boolean);
    if (files.length) { add(files); }
  });

  $('list').addEventListener('click', function (e) {
    var t = e.target.closest('[data-remove], [data-compare]');
    if (!t) { return; }
    if (t.dataset.remove) { remove(+t.dataset.remove); } else { openCompare(+t.dataset.compare); }
  });

  formatSel.addEventListener('change', function () { settings.format = this.value; syncFormat(); });
  document.querySelectorAll('[data-mode]').forEach(function (b) { b.addEventListener('click', function () { setMode(b.dataset.mode); }); });
  document.querySelectorAll('[data-size]').forEach(function (b) { b.addEventListener('click', function () { setSize(b.dataset.size); }); });
  $('quality').addEventListener('input', function () { settings.quality = +this.value; $('quality-out').textContent = this.value; });
  $('target').addEventListener('input', function () { settings.target = Math.max(5, +this.value || 200); });
  $('maxw').addEventListener('input', function () { settings.maxw = Math.max(100, +this.value || 1920); });

  $('redo').addEventListener('click', function () {
    items.forEach(function (i) { i.state = 'wait'; render(i); enqueue(i); });
    summary();
  });
  $('clear').addEventListener('click', function () {
    items.slice().forEach(function (i) { remove(i.id); });
  });
  $('zip').addEventListener('click', downloadAll);

  detectFormats().then(fillFormats);
  setMode('quality');
  setSize('original');
  summary();
}());