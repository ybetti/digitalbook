/* ==========================================================================
   Digital Book — flipbook engine
   A dependency-free page-turn viewer for pre-rendered PDF pages.
   ========================================================================== */

(function () {
  'use strict';

  var DATA = window.BOOK_DATA;
  if (!DATA) { return; }

  var N = DATA.pageCount;
  var AR = DATA.pages[0].w / DATA.pages[0].h;   // page aspect (w / h)
  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };

  var stage = $('stage'), viewport = $('viewport'), pan = $('pan'), book = $('book');
  var slotL = $('slotL'), slotR = $('slotR'), flipper = $('flipper');
  var faceF = $('faceF'), faceB = $('faceB'), leafShadow = $('leafShadow');
  var slider = $('slider'), pageLabel = $('pageLabel');

  var S = {
    mode: 'spread',   // effective display mode
    userMode: null,   // non-null once the reader picks a mode by hand
    flipped: 0,       // leaves turned, spread mode
    page: 1,          // current page, single mode
    zoom: 1,
    panX: 0, panY: 0,
    sound: false,
    animating: false,
    drag: null,
    panDrag: null
  };

  var PW = 400, PH = 566;
  var cache = {};

  /* ---------- small helpers ---------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n); }
  function pageSrc(n) { return 'pages/full/p' + pad3(n) + '.webp'; }
  function thumbSrc(n) { return 'pages/thumb/p' + pad3(n) + '.webp'; }

  var leafCount = function () { return Math.ceil(N / 2); };
  var maxFlipped = function () { return N % 2 ? leafCount() - 1 : leafCount(); };
  var leftPage = function (f) { return f === 0 ? 0 : (2 * f <= N ? 2 * f : 0); };
  var rightPage = function (f) { return 2 * f + 1 <= N ? 2 * f + 1 : 0; };

  function currentPage() {
    if (S.mode === 'single') { return S.page; }
    return leftPage(S.flipped) || rightPage(S.flipped);
  }

  function canGo(dir) {
    if (S.mode === 'single') {
      return dir > 0 ? S.page < N : S.page > 1;
    }
    return dir > 0 ? S.flipped < maxFlipped() : S.flipped > 0;
  }

  /* ---------- painting pages ---------- */

  function pageEls(n) {
    var frag = document.createDocumentFragment();
    var img = new Image();
    img.src = pageSrc(n);
    img.alt = 'ページ ' + n;
    img.decoding = 'async';
    img.draggable = false;
    frag.appendChild(img);

    var meta = DATA.pages[n - 1];
    if (meta && meta.links) {
      meta.links.forEach(function (l) {
        var a = document.createElement('a');
        a.className = 'plink';
        a.href = l.uri;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = l.uri;
        a.style.left = (l.x * 100) + '%';
        a.style.top = (l.y * 100) + '%';
        a.style.width = (l.w * 100) + '%';
        a.style.height = (l.h * 100) + '%';
        frag.appendChild(a);
      });
    }

    var badge = document.createElement('div');
    badge.className = 'pnum';
    badge.textContent = n;
    frag.appendChild(badge);
    return frag;
  }

  function fillSlot(slot, n) {
    slot.textContent = '';
    if (!n) { slot.classList.add('empty'); return; }
    slot.classList.remove('empty');
    slot.appendChild(pageEls(n));
  }

  function fillFace(face, n) {
    var shade = face.querySelector('.shade');
    face.textContent = '';
    face.classList.toggle('blank', !n);
    if (n) {
      var img = new Image();
      img.src = pageSrc(n);
      img.alt = '';
      img.draggable = false;
      face.appendChild(img);
    }
    face.appendChild(shade);
  }

  /* ---------- layout ---------- */

  function layout() {
    var w = stage.clientWidth, h = stage.clientHeight;
    var padX = w < 700 ? 10 : 60;
    var padY = w < 700 ? 12 : 26;
    var availW = Math.max(120, w - padX * 2);
    var availH = Math.max(120, h - padY * 2);
    var cols = S.mode === 'spread' ? 2 : 1;

    var ph = availH, pw = ph * AR;
    if (pw * cols > availW) { pw = availW / cols; ph = pw / AR; }

    PW = pw; PH = ph;
    root.style.setProperty('--pw', pw.toFixed(2) + 'px');
    root.style.setProperty('--ph', ph.toFixed(2) + 'px');
    root.style.setProperty('--cols', cols);
    updateShift();
  }

  // A lone cover sits centred; a full spread sits flush. Applying the target
  // offset when a turn starts lets the book "open" while the leaf swings.
  function updateShift(forFlipped) {
    var f = forFlipped === undefined ? S.flipped : forFlipped;
    var shift = 0, solo = false;
    if (S.mode === 'spread') {
      var l = leftPage(f), r = rightPage(f);
      if (!l) { shift = -PW / 2; solo = true; }
      else if (!r) { shift = PW / 2; solo = true; }
    }
    root.style.setProperty('--shift', shift.toFixed(2) + 'px');
    book.classList.toggle('solo', solo);
  }

  function render() {
    if (S.mode === 'spread') {
      fillSlot(slotL, leftPage(S.flipped));
      fillSlot(slotR, rightPage(S.flipped));
    } else {
      fillSlot(slotL, 0);
      fillSlot(slotR, S.page);
    }
    updateShift();
    updateUI();
    preload();
  }

  /* ---------- the flip ---------- */

  function beginFlip(dir) {
    var front, back, revealed;

    if (S.mode === 'spread') {
      if (dir > 0) {
        front = rightPage(S.flipped);
        back = 2 * S.flipped + 2 <= N ? 2 * S.flipped + 2 : 0;
        revealed = rightPage(S.flipped + 1);
        fillSlot(slotR, revealed);
      } else {
        front = leftPage(S.flipped);
        back = rightPage(S.flipped - 1);
        fillSlot(slotL, leftPage(S.flipped - 1));
      }
    } else {
      if (dir > 0) {
        front = S.page;
        back = 0;
        fillSlot(slotR, S.page + 1);
      } else {
        front = 0;
        back = S.page - 1;
      }
    }

    fillFace(faceF, front);
    fillFace(faceB, back);

    flipper.className = 'flipper ' + (dir > 0 ? 'fwd' : 'bwd');
    flipper.hidden = false;

    if (S.mode === 'spread') { updateShift(S.flipped + dir); }

    leafShadow.style.left = (dir > 0 && S.mode === 'spread') ? PW.toFixed(2) + 'px' : '0px';
    leafShadow.style.backgroundImage = dir > 0
      ? 'linear-gradient(to right, rgba(0,0,0,.55), rgba(0,0,0,0) 58%)'
      : 'linear-gradient(to left, rgba(0,0,0,.55), rgba(0,0,0,0) 58%)';
  }

  function setAngle(deg) {
    var p = Math.abs(deg) / 180;
    flipper.style.transform = 'rotateY(' + deg.toFixed(2) + 'deg)';
    faceF.querySelector('.shade').style.opacity = (p * 0.9).toFixed(3);
    faceB.querySelector('.shade').style.opacity = ((1 - p) * 0.9).toFixed(3);
    leafShadow.style.opacity = (Math.sin(p * Math.PI) * 0.45).toFixed(3);
  }

  function endFlip(dir, complete) {
    if (complete) {
      if (S.mode === 'spread') { S.flipped = clamp(S.flipped + dir, 0, maxFlipped()); }
      else { S.page = clamp(S.page + dir, 1, N); }
    }
    flipper.hidden = true;
    flipper.className = 'flipper';
    flipper.style.transform = '';
    leafShadow.classList.remove('snap');
    leafShadow.style.opacity = 0;
    S.animating = false;
    render();
  }

  function animateTo(target, dir, complete) {
    flipper.classList.add('snap');
    leafShadow.classList.add('snap');
    void flipper.offsetWidth;
    setAngle(target);

    var settled = false;
    var finish = function () {
      if (settled) { return; }
      settled = true;
      flipper.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
      endFlip(dir, complete);
    };
    var onEnd = function (e) { if (e.propertyName === 'transform') { finish(); } };
    flipper.addEventListener('transitionend', onEnd);
    var timer = setTimeout(finish, 760);
  }

  function doFlip(dir) {
    if (S.animating || !canGo(dir)) { return; }
    S.animating = true;
    beginFlip(dir);
    setAngle(0);
    void flipper.offsetWidth;
    playFlipSound();
    animateTo(dir > 0 ? -180 : 180, dir, true);
  }

  function goToPage(n, animate) {
    n = clamp(Math.round(n), 1, N);
    if (S.animating) { return; }

    if (S.mode === 'spread') {
      var target = n === 1 ? 0 : clamp(Math.floor(n / 2), 0, maxFlipped());
      if (target === S.flipped) { return; }
      if (animate !== false && Math.abs(target - S.flipped) === 1) {
        doFlip(target > S.flipped ? 1 : -1);
        return;
      }
      S.flipped = target;
    } else {
      if (n === S.page) { return; }
      if (animate !== false && Math.abs(n - S.page) === 1) {
        doFlip(n > S.page ? 1 : -1);
        return;
      }
      S.page = n;
    }

    book.classList.remove('jump');
    void book.offsetWidth;
    book.classList.add('jump');
    playFlipSound();
    render();
  }

  /* ---------- pointer: page dragging ---------- */

  function grabDirection(clientX) {
    if (S.mode === 'spread') {
      var l = leftPage(S.flipped), r = rightPage(S.flipped);
      if (!l) { return 1; }
      if (!r) { return -1; }
    }
    var rect = book.getBoundingClientRect();
    return (clientX - rect.left) > rect.width / 2 ? 1 : -1;
  }

  book.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.pointerType === 'mouse') { return; }
    if (e.target.closest && e.target.closest('.plink')) { return; }
    if (S.zoom > 1) { return; }          // zoomed in: viewport handles panning
    if (S.animating) { return; }

    S.drag = {
      dir: grabDirection(e.clientX),
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastT: performance.now(),
      v: 0, prog: 0, moved: false, started: false,
      pw: PW, id: e.pointerId
    };
    try { book.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  book.addEventListener('pointermove', function (e) {
    var d = S.drag;
    if (!d || e.pointerId !== d.id) { return; }

    var dx = e.clientX - d.startX;
    var dy = e.clientY - d.startY;

    if (!d.moved) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) { return; }
      if (Math.abs(dy) > Math.abs(dx) * 1.5) { S.drag = null; return; }

      var wanted = dx < 0 ? 1 : -1;
      if (canGo(wanted)) { d.dir = wanted; }
      if (!canGo(d.dir)) { S.drag = null; return; }

      d.moved = true;
      d.started = true;
      S.animating = true;
      beginFlip(d.dir);
      setAngle(0);
      playFlipSound();
    }

    var now = performance.now();
    var dt = Math.max(1, now - d.lastT);
    d.v = (d.lastX - e.clientX) / dt * d.dir;   // px/ms toward the turn
    d.lastX = e.clientX;
    d.lastT = now;

    d.prog = clamp((d.dir > 0 ? -dx : dx) / d.pw, 0, 1);
    setAngle(d.dir > 0 ? -180 * d.prog : 180 * d.prog);
  });

  function releaseDrag(e) {
    var d = S.drag;
    if (!d || (e && e.pointerId !== d.id)) { return; }
    S.drag = null;
    try { book.releasePointerCapture(d.id); } catch (err) { /* ignore */ }

    if (!d.moved) {
      hideHint();
      if (canGo(d.dir)) { doFlip(d.dir); }
      return;
    }
    if (!d.started) { return; }

    hideHint();
    var complete = d.prog > 0.3 || d.v > 0.55;
    animateTo(complete ? (d.dir > 0 ? -180 : 180) : 0, d.dir, complete);
  }

  book.addEventListener('pointerup', releaseDrag);
  book.addEventListener('pointercancel', releaseDrag);

  /* ---------- zoom & pan ---------- */

  function applyTransform() {
    var lim = function (v, span) { var m = Math.max(0, (S.zoom - 1) * span / 2); return clamp(v, -m, m); };
    S.panX = lim(S.panX, viewport.clientWidth);
    S.panY = lim(S.panY, viewport.clientHeight);
    pan.style.transform = 'translate3d(' + S.panX.toFixed(1) + 'px,' + S.panY.toFixed(1) + 'px,0) scale(' + S.zoom.toFixed(3) + ')';
  }

  function setZoom(z) {
    S.zoom = clamp(z, 1, 3.5);
    if (S.zoom <= 1.001) { S.zoom = 1; S.panX = 0; S.panY = 0; }
    applyTransform();
    $('btnZoomReset').textContent = Math.round(S.zoom * 100) + '%';
    viewport.style.cursor = S.zoom > 1 ? 'grab' : '';
  }

  viewport.addEventListener('pointerdown', function (e) {
    if (S.zoom <= 1) { return; }
    S.panDrag = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY, id: e.pointerId };
    pan.classList.add('dragging');
    viewport.style.cursor = 'grabbing';
    try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  viewport.addEventListener('pointermove', function (e) {
    var p = S.panDrag;
    if (!p || e.pointerId !== p.id) { return; }
    S.panX = p.px + (e.clientX - p.x);
    S.panY = p.py + (e.clientY - p.y);
    applyTransform();
  });

  function endPan(e) {
    if (!S.panDrag || (e && e.pointerId !== S.panDrag.id)) { return; }
    S.panDrag = null;
    pan.classList.remove('dragging');
    viewport.style.cursor = S.zoom > 1 ? 'grab' : '';
  }

  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  var lastWheel = 0;
  viewport.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(S.zoom * (e.deltaY > 0 ? 0.88 : 1.12));
      return;
    }
    if (S.zoom > 1) {
      e.preventDefault();
      S.panX -= e.deltaX;
      S.panY -= e.deltaY;
      applyTransform();
      return;
    }
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 6) { return; }
    var now = performance.now();
    if (now - lastWheel < 460) { return; }
    lastWheel = now;
    hideHint();
    doFlip(d > 0 ? 1 : -1);
  }, { passive: false });

  /* ---------- page-turn sound (synthesised, no asset) ---------- */

  var actx = null;
  function playFlipSound() {
    if (!S.sound) { return; }
    try {
      if (!actx) { actx = new (window.AudioContext || window.webkitAudioContext)(); }
      if (actx.state === 'suspended') { actx.resume(); }
      var dur = 0.4;
      var len = Math.floor(actx.sampleRate * dur);
      var buf = actx.createBuffer(1, len, actx.sampleRate);
      var ch = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        ch[i] = (Math.random() * 2 - 1) * Math.pow(Math.sin(Math.PI * t), 1.7) * (0.3 + 0.7 * t);
      }
      var src = actx.createBufferSource(); src.buffer = buf;
      var hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 850;
      var bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2700; bp.Q.value = 0.6;
      var g = actx.createGain(); g.gain.value = 0.16;
      src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(actx.destination);
      src.start();
    } catch (err) { /* audio is optional */ }
  }

  /* ---------- preloading ---------- */

  function preload() {
    var base = currentPage();
    for (var i = -4; i <= 7; i++) {
      var n = base + i;
      if (n >= 1 && n <= N && !cache[n]) {
        var im = new Image();
        im.decoding = 'async';
        im.src = pageSrc(n);
        cache[n] = im;
      }
    }
  }

  /* ---------- chrome / UI ---------- */

  function updateUI() {
    var l = S.mode === 'spread' ? leftPage(S.flipped) : 0;
    var r = S.mode === 'spread' ? rightPage(S.flipped) : S.page;
    var cur = l || r;

    pageLabel.textContent = (l && r ? l + '–' + r : String(cur)) + ' / ' + N;
    slider.value = cur;
    slider.style.setProperty('--fill', (N > 1 ? (cur - 1) / (N - 1) * 100 : 0) + '%');

    $('btnPrev').disabled = $('btnFirst').disabled = !canGo(-1);
    $('btnNext').disabled = $('btnLast').disabled = !canGo(1);
    $('edgePrev').disabled = !canGo(-1);
    $('edgeNext').disabled = !canGo(1);

    var cells = document.querySelectorAll('.thumb');
    for (var i = 0; i < cells.length; i++) {
      var n = +cells[i].dataset.page;
      cells[i].classList.toggle('current', n === l || n === r);
    }

    try { history.replaceState(null, '', '#p' + cur); } catch (err) { /* file:// */ }
  }

  function setMode(m, remember) {
    if (m === S.mode) { return; }
    var cur = currentPage();
    S.mode = m;
    root.dataset.mode = m;
    if (remember) { S.userMode = m; store('mode', m); }
    if (m === 'single') { S.page = cur; }
    else { S.flipped = cur === 1 ? 0 : clamp(Math.floor(cur / 2), 0, maxFlipped()); }
    $('btnSpread').firstElementChild.firstElementChild
      .setAttribute('href', m === 'spread' ? '#i-spread' : '#i-single');
    layout();
    render();
  }

  function autoSingle() {
    return stage.clientWidth < 720 || (stage.clientWidth / Math.max(1, stage.clientHeight)) < 1.08;
  }

  function applyAutoMode() {
    if (S.userMode) { return; }
    setMode(autoSingle() ? 'single' : 'spread', false);
  }

  /* ---------- storage ---------- */

  function store(k, v) { try { localStorage.setItem('digitalbook.' + k, v); } catch (e) { /* ignore */ } }
  function load(k) { try { return localStorage.getItem('digitalbook.' + k); } catch (e) { return null; } }

  /* ---------- drawers, modal, toast ---------- */

  function openDrawer(node) {
    closeOverlays(node);
    node.hidden = false;
    void node.offsetWidth;
    node.classList.add('open');
  }

  function closeDrawer(node) {
    node.classList.remove('open');
    setTimeout(function () { if (!node.classList.contains('open')) { node.hidden = true; } }, 320);
  }

  function closeOverlays(except) {
    ['drawerThumbs', 'drawerSearch'].forEach(function (id) {
      var n = $(id);
      if (n !== except && n.classList.contains('open')) { closeDrawer(n); }
    });
    var m = $('modalHelp');
    if (m !== except && m.classList.contains('open')) {
      m.classList.remove('open');
      setTimeout(function () { if (!m.classList.contains('open')) { m.hidden = true; } }, 240);
    }
    $('btnThumbs').classList.toggle('on', $('drawerThumbs').classList.contains('open'));
    $('btnSearch').classList.toggle('on', $('drawerSearch').classList.contains('open'));
  }

  function toggleDrawer(node) {
    if (node.classList.contains('open')) { closeDrawer(node); }
    else { openDrawer(node); }
    $('btnThumbs').classList.toggle('on', $('drawerThumbs').classList.contains('open'));
    $('btnSearch').classList.toggle('on', $('drawerSearch').classList.contains('open'));
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  var hintTimer = null;
  function hideHint() {
    $('hint').classList.remove('show');
    clearTimeout(hintTimer);
  }

  /* ---------- thumbnails ---------- */

  var thumbsBuilt = false;
  function buildThumbs() {
    if (thumbsBuilt) { return; }
    thumbsBuilt = true;
    var wrap = $('thumbs');
    var frag = document.createDocumentFragment();
    for (var n = 1; n <= N; n++) {
      var b = document.createElement('button');
      b.className = 'thumb';
      b.dataset.page = n;
      b.type = 'button';
      var img = document.createElement('img');
      img.src = thumbSrc(n);
      img.loading = 'lazy';
      img.alt = 'ページ ' + n;
      var s = document.createElement('span');
      s.textContent = n;
      b.appendChild(img);
      b.appendChild(s);
      frag.appendChild(b);
    }
    wrap.appendChild(frag);
    wrap.addEventListener('click', function (e) {
      var t = e.target.closest('.thumb');
      if (!t) { return; }
      goToPage(+t.dataset.page, false);
      if (stage.clientWidth < 900) { closeDrawer($('drawerThumbs')); closeOverlays(); }
    });
    updateUI();
  }

  /* ---------- search ---------- */

  var searchTimer = null;
  function runSearch(q) {
    var box = $('results'), count = $('searchCount');
    box.textContent = '';
    q = q.trim();
    if (!q) { count.textContent = ''; return; }

    var needle = q.toLowerCase();
    var hits = 0;
    var frag = document.createDocumentFragment();

    DATA.pages.forEach(function (p) {
      var t = p.text || '';
      var idx = t.toLowerCase().indexOf(needle);
      if (idx < 0) { return; }
      hits++;

      var from = Math.max(0, idx - 28);
      var to = Math.min(t.length, idx + q.length + 64);

      var btn = document.createElement('button');
      btn.className = 'result';
      btn.type = 'button';
      btn.dataset.page = p.n;

      var head = document.createElement('b');
      head.textContent = 'P.' + p.n;
      btn.appendChild(head);

      var para = document.createElement('p');
      para.appendChild(document.createTextNode((from > 0 ? '…' : '') + t.slice(from, idx)));
      var mk = document.createElement('mark');
      mk.textContent = t.substr(idx, q.length);
      para.appendChild(mk);
      para.appendChild(document.createTextNode(t.slice(idx + q.length, to) + (to < t.length ? '…' : '')));
      btn.appendChild(para);

      frag.appendChild(btn);
    });

    box.appendChild(frag);
    count.textContent = hits ? hits + ' 件のページが見つかりました' : '該当するページはありません';
  }

  $('results').addEventListener('click', function (e) {
    var r = e.target.closest('.result');
    if (!r) { return; }
    goToPage(+r.dataset.page, false);
    if (stage.clientWidth < 900) { closeDrawer($('drawerSearch')); closeOverlays(); }
  });

  $('searchInput').addEventListener('input', function (e) {
    var v = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { runSearch(v); }, 170);
  });

  /* ---------- controls ---------- */

  $('btnNext').addEventListener('click', function () { hideHint(); doFlip(1); });
  $('btnPrev').addEventListener('click', function () { hideHint(); doFlip(-1); });
  $('edgeNext').addEventListener('click', function () { hideHint(); doFlip(1); });
  $('edgePrev').addEventListener('click', function () { hideHint(); doFlip(-1); });
  $('btnFirst').addEventListener('click', function () { goToPage(1, false); });
  $('btnLast').addEventListener('click', function () { goToPage(N, false); });

  slider.addEventListener('input', function () { goToPage(+slider.value, false); });

  $('sliderWrap').addEventListener('pointermove', function (e) {
    var rect = slider.getBoundingClientRect();
    var ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    var n = clamp(Math.round(1 + ratio * (N - 1)), 1, N);
    var prev = $('sliderPreview');
    prev.hidden = false;
    prev.style.left = clamp(e.clientX - rect.left, 50, rect.width - 50) + 'px';
    $('spImg').src = thumbSrc(n);
    $('spNum').textContent = 'P.' + n;
  });

  $('sliderWrap').addEventListener('pointerleave', function () { $('sliderPreview').hidden = true; });

  $('btnZoomIn').addEventListener('click', function () { setZoom(S.zoom * 1.25); });
  $('btnZoomOut').addEventListener('click', function () { setZoom(S.zoom / 1.25); });
  $('btnZoomReset').addEventListener('click', function () { setZoom(1); });

  function scrollThumbsToCurrent() {
    var cur = document.querySelector('.thumb.current');
    if (cur && cur.scrollIntoView) { cur.scrollIntoView({ block: 'center' }); }
  }

  $('btnThumbs').addEventListener('click', function () {
    buildThumbs();
    toggleDrawer($('drawerThumbs'));
    if ($('drawerThumbs').classList.contains('open')) { setTimeout(scrollThumbsToCurrent, 60); }
  });

  $('btnSearch').addEventListener('click', function () {
    toggleDrawer($('drawerSearch'));
    if ($('drawerSearch').classList.contains('open')) { setTimeout(function () { $('searchInput').focus(); }, 260); }
  });

  $('btnSpread').addEventListener('click', function () {
    setMode(S.mode === 'spread' ? 'single' : 'spread', true);
    toast(S.mode === 'spread' ? '見開き表示' : '単ページ表示');
  });

  $('btnSound').addEventListener('click', function () {
    S.sound = !S.sound;
    store('sound', S.sound ? '1' : '0');
    $('btnSound').classList.toggle('on', S.sound);
    $('btnSound').firstElementChild.firstElementChild.setAttribute('href', S.sound ? '#i-sound' : '#i-mute');
    toast(S.sound ? 'めくり音 オン' : 'めくり音 オフ');
    if (S.sound) { playFlipSound(); }
  });

  $('btnTheme').addEventListener('click', function () {
    var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    store('theme', next);
    $('btnTheme').firstElementChild.firstElementChild.setAttribute('href', next === 'dark' ? '#i-sun' : '#i-moon');
  });

  $('btnFull').addEventListener('click', function () {
    if (document.fullscreenElement) { document.exitFullscreen(); }
    else if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen(); }
  });

  document.addEventListener('fullscreenchange', function () {
    var on = !!document.fullscreenElement;
    $('btnFull').classList.toggle('on', on);
    $('btnFull').firstElementChild.firstElementChild.setAttribute('href', on ? '#i-exit' : '#i-full');
    setTimeout(layout, 120);
  });

  $('btnHelp').addEventListener('click', function () {
    var m = $('modalHelp');
    if (m.classList.contains('open')) { closeOverlays(); return; }
    closeOverlays(m);
    m.hidden = false;
    void m.offsetWidth;
    m.classList.add('open');
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) { closeOverlays(); }
    if (e.target.id === 'modalHelp') { closeOverlays(); }
  });

  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') { e.target.blur(); closeOverlays(); }
      return;
    }

    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case ' ':
        e.preventDefault(); hideHint(); doFlip(1); return;
      case 'ArrowLeft': case 'PageUp':
        e.preventDefault(); hideHint(); doFlip(-1); return;
      case 'Home': e.preventDefault(); goToPage(1, false); return;
      case 'End': e.preventDefault(); goToPage(N, false); return;
      case 'Escape': closeOverlays(); return;
      case '+': case '=': setZoom(S.zoom * 1.25); return;
      case '-': setZoom(S.zoom / 1.25); return;
      case '0': setZoom(1); return;
      case '?': $('btnHelp').click(); return;
    }

    var k = e.key.toLowerCase();
    if (k === 't') { $('btnThumbs').click(); }
    else if (k === 'f') { e.preventDefault(); $('btnSearch').click(); }
    else if (k === 'd') { $('btnSpread').click(); }
    else if (k === 's') { $('btnSound').click(); }
    else if (k === 'e') { $('btnFull').click(); }
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { applyAutoMode(); layout(); applyTransform(); }, 120);
  });

  window.addEventListener('hashchange', function () {
    var m = /^#p(\d+)$/.exec(location.hash);
    if (m) { goToPage(+m[1], false); }
  });

  /* ---------- boot ---------- */

  function boot() {
    document.title = DATA.title + '｜デジタルブック';
    $('bookTitle').textContent = DATA.title;
    $('bookSub').textContent = N + ' ページ';
    $('loaderTitle').textContent = DATA.title;

    var pdf = $('btnPdf');
    if (DATA.pdf) {
      pdf.href = encodeURI(DATA.pdf);
      pdf.setAttribute('download', DATA.pdf);
    } else {
      pdf.hidden = true;
    }

    slider.max = N;

    if (load('theme')) {
      root.dataset.theme = load('theme');
      $('btnTheme').firstElementChild.firstElementChild
        .setAttribute('href', root.dataset.theme === 'dark' ? '#i-sun' : '#i-moon');
    }
    if (load('sound') === '1') {
      S.sound = true;
      $('btnSound').classList.add('on');
      $('btnSound').firstElementChild.firstElementChild.setAttribute('href', '#i-sound');
    }
    var savedMode = load('mode');
    if (savedMode === 'single' || savedMode === 'spread') { S.userMode = savedMode; }

    S.mode = S.userMode || (autoSingle() ? 'single' : 'spread');
    root.dataset.mode = S.mode;
    $('btnSpread').firstElementChild.firstElementChild
      .setAttribute('href', S.mode === 'spread' ? '#i-spread' : '#i-single');

    var start = 1;
    var h = /^#p(\d+)$/.exec(location.hash);
    if (h) { start = clamp(+h[1], 1, N); }
    if (S.mode === 'single') { S.page = start; }
    else { S.flipped = start === 1 ? 0 : clamp(Math.floor(start / 2), 0, maxFlipped()); }

    layout();
    render();
    setZoom(1);

    // reveal once the opening pages are decoded
    var first = [];
    for (var i = 0; i < 4; i++) { var n = start + i; if (n <= N) { first.push(n); } }
    var done = 0;
    var bar = $('loaderBar');
    var reveal = function () {
      var ld = $('loader');
      if (ld.classList.contains('done')) { return; }
      ld.classList.add('done');
      setTimeout(function () { ld.style.display = 'none'; }, 520);
      $('hint').classList.add('show');
      hintTimer = setTimeout(hideHint, 5200);
    };

    first.forEach(function (n) {
      var im = cache[n] || new Image();
      cache[n] = im;
      var tick = function () {
        done++;
        bar.style.width = Math.round(done / first.length * 100) + '%';
        if (done >= first.length) { setTimeout(reveal, 180); }
      };
      if (im.complete && im.naturalWidth) { tick(); }
      else { im.addEventListener('load', tick); im.addEventListener('error', tick); im.src = pageSrc(n); }
    });

    setTimeout(reveal, 7000);   // never trap the reader behind the loader
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
