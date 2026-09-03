/* =========================================================
   Vision 360 Mobile — clickable prototype
   Router + wiring over the accepted design screens.
   ========================================================= */
(function () {
  'use strict';

  var META = window.__SCREENS__ || [];
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var byId = function (id) { return document.getElementById(id); };

  var phone = byId('phone');
  var viewport = byId('viewport');
  var MISS = [];

  /* Lift overlays out of the scrolling viewport into the phone itself, so a
     bottom sheet dims and covers the status bar and tab bar too. */
  var ovLayer = document.createElement('div');
  ovLayer.id = 'overlays';
  phone.appendChild(ovLayer);
  $$('.overlay', viewport).forEach(function (el) { ovLayer.appendChild(el); });
  phone.appendChild(byId('toast'));   // toasts sit above sheets

  /* ---------- screen registry ---------- */
  var INFO = {};                                   // id -> {tabs, sb, title, section, overlay}
  META.forEach(function (m) { INFO[m.id] = m; });
  $$('.screen, .overlay', phone).forEach(function (el) {
    if (!INFO[el.id]) {
      INFO[el.id] = {
        id: el.id, title: el.id, section: 'app',
        tabs: el.dataset.tabs === 'on', overlay: el.classList.contains('overlay')
      };
    }
    INFO[el.id].overlay = el.classList.contains('overlay');
  });
  var isOv = function (id) { return !!(INFO[id] && INFO[id].overlay); };

  /* ---------- flow state ---------- */
  var state = {
    onsite: false,
    enroute: false,     // driving to the job — a status the button holds
    est: 'none',        // none draft review ready approved
    inv: 'none',        // none sent paid
    extra: false        // additional items added
  };
  var EST = { none: 'est-empty', draft: 'est-draft', review: 'est-review', ready: 'est-ready', approved: 'est-approved' };
  function estScreen() { return EST[state.est]; }
  function finScreen() {
    if (state.inv === 'paid') return 'inv-paid';
    if (state.inv === 'sent') return 'inv-sent';
    return state.extra ? 'add-items' : 'fin-empty';
  }
  function homeScreen() { return state.onsite ? 'home-active' : 'home'; }

  /* ---------- router ---------- */
  var stack = [];
  var scrollMem = {};

  function curPage() {
    for (var i = stack.length - 1; i >= 0; i--) if (!isOv(stack[i].id)) return stack[i].id;
    return null;
  }
  function topId() { return stack.length ? stack[stack.length - 1].id : null; }

  var ANIM = {
    push: ['inR', 'outL'], pop: ['inL', 'outR'],
    up: ['inU', 'outF'], down: ['inF', 'outU'], fade: ['inF', 'outF']
  };

  function animate(fromEl, toEl, kind) {
    var a = ANIM[kind][0], b = ANIM[kind][1];
    if (fromEl && fromEl !== toEl) {
      var s = $('.sc', fromEl); if (s) scrollMem[fromEl.id] = s.scrollTop;
      fromEl.classList.remove('on');
      fromEl.classList.add('leaving', 'anim-' + b);
      (function (el, cls) {
        setTimeout(function () { el.classList.remove('leaving', 'anim-' + cls); }, 330);
      })(fromEl, b);
    }
    toEl.classList.add('on', 'anim-' + a);
    setTimeout(function () { toEl.classList.remove('anim-' + a); }, 350);
    $$('.sc', toEl).forEach(function (s) {
      s.scrollTop = (kind === 'pop' || kind === 'down') ? (scrollMem[toEl.id] || 0) : 0;
    });
  }

  function closeOverlays(instant) {
    for (var i = stack.length - 1; i >= 0; i--) {
      if (isOv(stack[i].id)) { hideOverlay(stack[i].id, instant); stack.splice(i, 1); }
    }
  }
  function hideOverlay(id, instant) {
    var el = byId(id); if (!el) return;
    if (instant) { el.classList.remove('on'); return; }
    el.classList.remove('on');
    el.classList.add('leaving', 'anim-outF');
    setTimeout(function () { el.classList.remove('leaving', 'anim-outF'); }, 220);
  }

  function go(id, mode) {
    if (!id) return;
    if (id === 'BACK') return back();
    var el = byId(id);
    if (!el) { console.warn('[proto] no screen', id); return; }

    if (isOv(id)) {
      if (topId() === id) return;
      stack.push({ id: id, mode: 'overlay' });
      el.classList.add('on', 'anim-inF');
      setTimeout(function () { el.classList.remove('anim-inF'); }, 250);
      chrome();
      return;
    }

    closeOverlays(true);
    var fromId = curPage();
    if (fromId === id) { chrome(); return; }
    var fromEl = fromId ? byId(fromId) : null;

    mode = mode || 'push';
    if (mode === 'tab' || mode === 'root') { stack = [{ id: id, mode: 'root' }]; animate(fromEl, el, 'fade'); }
    else if (mode === 'replace') {
      if (stack.length) stack[stack.length - 1] = { id: id, mode: stack[stack.length - 1].mode };
      else stack = [{ id: id, mode: 'root' }];
      animate(fromEl, el, 'fade');
    }
    else if (mode === 'modal') { stack.push({ id: id, mode: 'modal' }); animate(fromEl, el, 'up'); }
    else { stack.push({ id: id, mode: 'push' }); animate(fromEl, el, 'push'); }
    chrome();
  }

  /* pop consecutive top pages while `test(id)` holds — used by the pickers */
  function popWhile(test) {
    if (stack.length < 2) return;
    var fromId = curPage(), popped = false;
    while (stack.length > 1 && test(topId())) { stack.pop(); popped = true; }
    if (!popped) return;
    var toId = curPage();
    if (toId !== fromId) animate(byId(fromId), byId(toId), 'pop');
    chrome();
  }

  function back() {
    if (stack.length < 2) return;
    var top = stack.pop();
    if (isOv(top.id)) { hideOverlay(top.id); chrome(); return; }
    var toId = curPage();
    animate(byId(top.id), byId(toId), top.mode === 'modal' ? 'down' : 'pop');
    chrome();
  }

  var TABOF = {
    home: 'home', 'home-active': 'home', photos: 'home', 'photo-detail': 'home', 'cust-jobs': 'home',
    files: 'home', 'image-desc': 'home', closeout: 'home',
    'more-profile': 'more', 'more-equipment': 'more', 'more-assets': 'more',
    'more-notifications': 'more', 'more-offline': 'more', 'more-help': 'more',
    history: 'history', 'hist-filters': 'history', 'hist-search': 'history',
    'period-quarter': 'home', 'period-week': 'home',
    chat: 'chat', 'chat-thread': 'chat', timesheet: 'timesheet', more: 'more'
  };

  function chrome() {
    var pid = curPage(); if (!pid) return;
    var m = INFO[pid] || {};
    phone.setAttribute('data-tabs', m.tabs ? 'on' : 'off');
    phone.setAttribute('data-sb', m.sb ? 'dark' : 'light');
    var t = TABOF[pid] || (/^(est-|rc-|job-|fin-|inv-|pay-|add-)/.test(pid) ? 'home' : 'home');
    $$('.tab', byId('tabbar')).forEach(function (el) {
      var on = el.dataset.tab === t;
      el.classList.toggle('on', on);
      var ic = $('.ic', el);
      ic.className = (on ? 'mif' : 'mi') + ' ic';
    });
  }

  /* ---------- toast ---------- */
  var toastT;
  function toast(msg, icon) {
    var t = byId('toast');
    byId('toastMsg').textContent = msg;
    $('.mi', t).textContent = icon || 'check_circle';
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('on'); }, 2100);
  }

  /* ---------- element pickers ---------- */
  function norm(s) { return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }

  function byText(root, txt) {
    var t = norm(txt).toLowerCase();
    var all = $$('div,span', root).filter(function (e) { return norm(e.textContent).toLowerCase() === t; });
    return all.filter(function (e) {
      return !all.some(function (o) { return o !== e && e.contains(o); });
    });
  }
  function byIcon(root, name) {
    return $$('.mi,.mif', root).filter(function (e) { return norm(e.textContent) === name; });
  }
  // own text nodes only — for rows like `<div>This week<span class=mi>…</span></div>`
  function byOwnText(root, txt) {
    var t = norm(txt).toLowerCase();
    return $$('div,span', root).filter(function (e) {
      var own = '';
      for (var i = 0; i < e.childNodes.length; i++) {
        if (e.childNodes[i].nodeType === 3) own += e.childNodes[i].nodeValue;
      }
      return norm(own).toLowerCase() === t;
    });
  }
  // spec: "Text" | "~OwnText" | "@icon" | trailing "#n" (nth match) then "^n" (climb n ancestors)
  function sel(root, q) {
    var up = 0, nth = null;
    q = q.replace(/\^(\d+)$/, function (_, d) { up = +d; return ''; });
    q = q.replace(/#(\d+)$/, function (_, d) { nth = +d; return ''; });
    var list = q.charAt(0) === '@' ? byIcon(root, q.slice(1))
      : q.charAt(0) === '~' ? byOwnText(root, q.slice(1))
        : byText(root, q);
    if (nth !== null) list = list[nth] ? [list[nth]] : [];
    return list.map(function (e) {
      var x = e;
      for (var i = 0; i < up && x.parentElement && x.parentElement !== root; i++) x = x.parentElement;
      return x;
    });
  }

  function mark(el, target, mode, act) {
    el.dataset.tap = '1';
    if (act) el.dataset.act = act; else el.dataset.go = target;
    if (mode) el.dataset.mode = mode;
  }

  /* specs: [query, target, mode]  — target 'BACK' pops, '@act:name' runs an action */
  function link(id, specs) {
    var root = byId(id);
    if (!root) { MISS.push(id + ' :: MISSING SCREEN'); return; }
    specs.forEach(function (sp) {
      var q = sp[0], target = sp[1], mode = sp[2];
      var els = sel(root, q);
      if (!els.length) { MISS.push(id + ' :: ' + q); return; }
      els.forEach(function (e) {
        if (e.dataset.go || e.dataset.act) return;
        if (target && target.indexOf('act:') === 0) mark(e, null, mode, target.slice(4));
        else mark(e, target, mode);
      });
    });
  }

  /* ---------- segmented controls ---------- */
  function seg(id, labels, active, onPick) {
    var root = byId(id); if (!root) return;
    var els = labels.map(function (l) { return sel(root, l)[0]; });
    if (els.some(function (e) { return !e; })) { MISS.push(id + ' :: seg ' + labels.join('/')); return; }
    var styles = els.map(function (e) { return e.getAttribute('style') || ''; });
    var ai = active, ii = active === 0 ? 1 : 0;
    var ACT = styles[ai], INA = styles[ii];
    var actIcon = $('.mi,.mif', els[ai]), inaIcon = $('.mi,.mif', els[ii]);
    var marker = null, markerFirst = false, iconPair = null;
    if (actIcon && !inaIcon) { marker = actIcon; markerFirst = els[ai].firstElementChild === actIcon; }
    else if (actIcon && inaIcon && norm(actIcon.textContent) !== norm(inaIcon.textContent)) {
      iconPair = {
        a: [norm(actIcon.textContent), actIcon.className, actIcon.getAttribute('style') || ''],
        i: [norm(inaIcon.textContent), inaIcon.className, inaIcon.getAttribute('style') || '']
      };
    }
    var cur = active;
    function paint(i) {
      if (i === cur) return;
      var prev = cur; cur = i;
      els[prev].setAttribute('style', INA);
      els[i].setAttribute('style', ACT);
      if (iconPair) {
        setIcon($('.mi,.mif', els[prev]), iconPair.i);
        setIcon($('.mi,.mif', els[i]), iconPair.a);
      } else if (marker) {
        if (markerFirst && els[i].firstElementChild) els[i].insertBefore(marker, els[i].firstElementChild);
        else els[i].appendChild(marker);
      }
      if (onPick) onPick(i, labels[i], els[i]);
    }
    function setIcon(el, spec) { if (!el) return; el.textContent = spec[0]; el.className = spec[1]; el.setAttribute('style', spec[2]); }
    els.forEach(function (e, i) {
      e.dataset.tap = '1';
      e.dataset.seg = '1';
      e.addEventListener('click', function (ev) { ev.stopPropagation(); paint(i); }, true);
    });
  }

  /* ---------- icon toggle (checkbox / switch) ---------- */
  function iconToggle(id, q, a, b, colorA, colorB) {
    var root = byId(id); if (!root) return;
    var els = sel(root, q);
    if (!els.length) { MISS.push(id + ' :: tgl ' + q); return; }
    els.forEach(function (e) {
      e.dataset.tap = '1';
      e.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var on = norm(e.textContent) === a;
        e.textContent = on ? b : a;
        e.className = on ? 'mif' : 'mi';
        if (colorA) e.style.color = on ? colorB : colorA;
      }, true);
    });
  }

  /* ---------- multi-select chips (on/off, independent) ---------- */
  function chips(id, onLabels, offLabels) {
    var root = byId(id); if (!root) return null;
    var on = onLabels.map(function (l) { return sel(root, l)[0]; }).filter(Boolean);
    var off = offLabels.map(function (l) { return sel(root, l)[0]; }).filter(Boolean);
    if (!on.length || !off.length) { MISS.push(id + ' :: chips'); return null; }
    var ON = { style: on[0].getAttribute('style'), icon: $('.mi,.mif', on[0]) };
    var OFF = { style: off[0].getAttribute('style') };
    var iconHTML = ON.icon ? ON.icon.outerHTML : '';
    var all = on.concat(off);
    function paint(c, isOn) {
      c.dataset.on = isOn ? '1' : '0';
      c.setAttribute('style', isOn ? ON.style : OFF.style);
      c.innerHTML = (isOn ? iconHTML : '') + c.dataset.label;
    }
    all.forEach(function (c) {
      c.dataset.label = norm(c.textContent).replace(/^check/, '');
      c.dataset.start = on.indexOf(c) > -1 ? '1' : '0';
      c.dataset.on = c.dataset.start;
      c.dataset.tap = '1';
      c.addEventListener('click', function (ev) {
        ev.stopPropagation();
        paint(c, c.dataset.on !== '1');
      }, true);
    });
    return function reset() {
      all.forEach(function (c) { paint(c, c.dataset.start === '1'); });
    };
  }

  /* ---------- iOS-style switches baked into the design ---------- */
  function switches(id, onToggle) {
    var root = byId(id); if (!root) return null;
    var found = [];
    $$('div', root).forEach(function (e) {
      var st = e.getAttribute('style') || '';
      if (!/width:52px;height:31px;border-radius:16px/.test(st)) return;
      var knob = e.firstElementChild; if (!knob) return;
      var startOn = /background:#4A6FA5/.test(st);
      e.dataset.tap = '1';
      e.style.transition = 'background .18s';
      knob.style.transition = 'left .18s,right .18s';
      function paint(on) {
        e.style.background = on ? '#4A6FA5' : '#DDE3EE';
        if (on) { knob.style.left = 'auto'; knob.style.right = '3px'; }
        else { knob.style.right = 'auto'; knob.style.left = '3px'; }
        e.dataset.on = on ? '1' : '0';
      }
      paint(startOn);
      e.addEventListener('click', function (ev) {
        ev.stopPropagation();
        paint(e.dataset.on !== '1');
        if (onToggle) onToggle(e, e.dataset.on === '1');
      }, true);
      found.push(function () { paint(startOn); });
    });
    return function reset() { found.forEach(function (f) { f(); }); };
  }

  /* ---------- catalog Add / Added pills ---------- */
  function money(s) { var m = String(s).replace(/[^0-9.]/g, ''); return parseFloat(m) || 0; }
  function fmt(n) { return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function catalog(id) {
    var root = byId(id); if (!root) return;
    var addPills = sel(root, '@add^1'), donePills = sel(root, '@check^1');
    if (!addPills.length || !donePills.length) { MISS.push(id + ' :: catalog pills'); return; }
    var ADD = { html: addPills[0].innerHTML, style: addPills[0].getAttribute('style') };
    var DONE = { html: donePills[0].innerHTML, style: donePills[0].getAttribute('style') };
    var pills = donePills.concat(addPills);
    var counter = root.querySelector('*');
    var cEl = null, sEl = null;
    $$('div', root).forEach(function (e) {
      var t = norm(e.textContent);
      if (/^\d+ items? added$/.test(t) && !cEl) cEl = e;
      if (/^Subtotal \$/.test(t) && !sEl) sEl = e;
    });
    function priceOf(p) {
      var box = p.parentElement, d = $$('div,span', box).filter(function (x) { return /^\$[\d,]+\.\d\d$/.test(norm(x.textContent)); })[0];
      return d ? money(d.textContent) : 0;
    }
    // start from the numbers in the accepted design and move by deltas,
    // so the copy stays true until the user actually taps something
    var base = {
      n: cEl ? parseInt(norm(cEl.textContent), 10) || 0 : 0,
      sum: sEl ? money(sEl.textContent) : 0
    };
    function render() {
      if (cEl) cEl.textContent = base.n + (base.n === 1 ? ' item added' : ' items added');
      if (sEl) sEl.textContent = 'Subtotal ' + fmt(Math.max(0, base.sum));
    }
    pills.forEach(function (p) {
      p.dataset.on = donePills.indexOf(p) > -1 ? '1' : '0';
      p.dataset.tap = '1';
      p.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var on = p.dataset.on === '1';
        p.dataset.on = on ? '0' : '1';
        p.innerHTML = on ? ADD.html : DONE.html;
        p.setAttribute('style', on ? ADD.style : DONE.style);
        p.classList.add('press');
        setTimeout(function () { p.classList.remove('press'); }, 200);
        base.n = Math.max(0, base.n + (on ? -1 : 1));
        base.sum += (on ? -1 : 1) * priceOf(p);
        render();
      }, true);
    });
  }

  /* ---------- qty steppers ---------- */
  function steppers(id, totalLabels) {
    var root = byId(id); if (!root) return;
    var boxes = $$('div', root).filter(function (e) {
      if (e.children.length !== 3) return false;
      var a = $('.mi,.mif', e.children[0]), c = $('.mi,.mif', e.children[2]);
      return a && c && norm(a.textContent) === 'remove' && norm(c.textContent) === 'add';
    });
    if (!boxes.length) return;
    var lines = boxes.map(function (b) {
      var row = b.parentElement;
      var pEl = $$('div,span', row).filter(function (x) { return x !== b && !b.contains(x) && /^\$[\d,]+\.\d\d$/.test(norm(x.textContent)); })[0];
      var q = parseInt(norm(b.children[1].textContent), 10) || 1;
      var total = pEl ? money(pEl.textContent) : 0;
      return { box: b, qEl: b.children[1], pEl: pEl, unit: q ? total / q : total, q: q };
    });
    // totals keep the value from the design and move by the delta the tap causes
    var totEls = [];
    (totalLabels || []).forEach(function (lab) {
      var l = sel(root, lab)[0];
      if (!l) return;
      var row = l.parentElement;
      var v = $$('div,span', row).filter(function (x) { return x !== l && /^\$[\d,]+\.\d\d$/.test(norm(x.textContent)); })[0];
      if (v) totEls.push({ el: v, val: money(v.textContent) });
    });
    function shift(delta) {
      totEls.forEach(function (t) { t.val = Math.max(0, t.val + delta); t.el.textContent = fmt(t.val); });
    }
    lines.forEach(function (l) {
      [[0, -1], [2, 1]].forEach(function (p) {
        var btn = l.box.children[p[0]], d = p[1];
        btn.dataset.tap = '1';
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var q = Math.max(1, l.q + d);
          if (q === l.q) return;
          l.q = q;
          l.qEl.textContent = String(l.q);
          if (l.pEl) l.pEl.textContent = fmt(l.unit * l.q);
          shift(d * l.unit);
        }, true);
      });
    });
  }

  /* =========================================================
     Wiring — the navigation graph
     ========================================================= */

  /* --- generic job tab strip (appears on 13 screens) --- */
  var JOBTABS = ['General', 'Notes', 'Report Card', 'Estimate', 'Finance'];
  function wireJobTabs(id) {
    var root = byId(id); if (!root) return;
    var strip = $$('div', root).filter(function (e) {
      if (e.children.length !== 5) return false;
      return JOBTABS.every(function (l, i) { return norm(e.children[i].textContent) === l; });
    })[0];
    if (!strip) { MISS.push(id + ' :: jobtabs'); return; }
    var acts = ['jobGeneral', 'jobNotes', 'jobRC', 'jobEst', 'jobFin'];
    JOBTABS.forEach(function (l, i) {
      var e = strip.children[i];
      e.dataset.tap = '1';
      e.dataset.act = acts[i];
    });
  }

  /* --- named actions --- */
  var ACT = {
    jobGeneral: function () { go('job-general', 'replace'); },
    jobNotes: function () { go('ov-notes'); },
    jobRC: function () { go('rc-overview', 'replace'); },
    jobEst: function () { go(estScreen(), 'replace'); },
    jobFin: function () { go(finScreen(), 'replace'); },

    start: function () {
      state.onsite = true;
      state.enroute = false;          // you've arrived — the en route state is spent
      paintEnroute();
      go('home-active', 'root');
      queued('Job status');
      toast('Job started · timer running', 'play_circle');
    },
    enroute: function () {
      state.enroute = !state.enroute;
      paintEnroute();
      closeOverlays(false);
      queued('Job status');
      toast(state.enroute ? 'Marked en route · customer notified' : 'No longer en route',
        state.enroute ? 'navigation' : 'undo');
    },
    dismissBanner: function (el) {
      var b = el.closest('div[style*="background:#1C2B3A"]') || el.parentElement;
      b.style.transition = 'opacity .2s,margin-top .22s,height .22s';
      b.style.overflow = 'hidden'; b.style.height = b.offsetHeight + 'px';
      requestAnimationFrame(function () { b.style.opacity = '0'; b.style.height = '0'; b.style.padding = '0 16px'; });
    },

    estSaveOption: function () { state.est = 'draft'; go('est-draft', 'root'); toast('Option saved to draft estimate'); },
    estSendReview: function () { state.est = 'review'; go('est-review', 'replace'); toast('Sent to your manager for review', 'send'); },
    estApprove: function () { state.est = 'ready'; go('est-ready', 'replace'); toast('Manager approved — ready to present', 'verified'); },
    estOrder: function () { state.est = 'approved'; closeOverlays(true); go('est-approved', 'root'); toast('Order confirmed · Option C signed'); },
    estCatalogDone: function () { back(); toast('Items added to Option A'); },

    createInvoice: function () { state.inv = 'sent'; go('inv-sent', 'replace'); toast('Invoice INV-26-03-123 created & sent', 'receipt_long'); },
    payDone: function () { state.inv = 'paid'; closeOverlays(true); go('inv-paid', 'root'); toast('Payment received · $2,000.00'); },
    addItemsDone: function () { state.extra = true; go('add-items', 'replace'); toast('2 items added to the invoice'); },

    rcSave: function (el) {
      var scr = el.closest('.screen');
      if (scr) hideSaveBar(scr.id);
      queued('Report Card');
      back();
      toast(net.online ? 'Report Card saved' : 'Report Card saved locally — will sync');
    },
    mediaSaved: function () {
      queued('Photo');
      back();
      toast(net.online ? 'Photo uploaded' : 'Photo saved — will upload on reconnect',
        net.online ? 'cloud_done' : 'cloud_off');
    },
    // "Set to Completed" runs the SOP closeout first — the job isn't done
    // until the twelve fields are in (US-M05-2)
    complete: function () {
      closeOverlays(true);
      go('closeout', 'modal');
    },
    closeoutSave: function () {
      queued('Closeout');
      back();
      toast(net.online ? 'Closeout saved' : 'Closeout saved — will sync', 'save');
    },
    closeoutComplete: function () {
      state.onsite = false;
      state.enroute = false;
      state.est = 'none'; state.inv = 'none'; state.extra = false;  // next job starts clean
      paintEnroute();
      jobIdx++;
      paintJob();
      closeOverlays(true);
      go('home', 'root');
      queued('Job status');
      toast(JOBS[jobIdx] ? 'Job closed — next one unlocked'
        : 'Job closed — nothing left today', 'task_alt');
    },
    logout: function () {
      state = { onsite: false, enroute: false, est: 'none', inv: 'none', extra: false };
      go('login', 'root'); toast('Signed out', 'logout');
    }
  };

  /* --- per-screen link tables --- */
  var LINKS = {
    'home': [
      ['@close', 'act:dismissBanner'],
      ['@play_arrow^1', 'act:start'],
      ['@navigation^1', 'act:enroute'],
      ['@more_horiz^1', 'ov-job-actions'],
      ['Randy Johnson^2', 'job-general'],
      ['@description^1', 'ov-note-detailed'],
      ['@lock^1', 'ov-note-private'],
      ['@build^1', 'ov-note-tech'],
      ['@photo_library^1', 'photos'],
      ['@attach_file^1', 'files'],
      ['@history^1', 'cust-jobs'],
      ['~Demand Service', 'ov-worktype'],
      // US-M03-2: the notifications row leads to the work it's telling you about
      ['@campaign^1', 'history']
    ],
    'home-active': [
      ['On site · Randy Johnson^1', 'job-general'],
      ['Randy Johnson^2', 'job-general'],
      ['@assignment^1', 'job-general'],
      ['@more_horiz^1', 'ov-job-actions'],
      ['@description^1', 'ov-note-detailed'],
      ['@lock^1', 'ov-note-private'],
      ['@photo_library^1', 'photos'],
      ['@attach_file^1', 'files'],
      ['@photo_camera^1', 'ov-media-source'],
      ['@edit_note^1', 'ov-note-tech'],
      ['@fact_check^1', 'rc-overview'],
      ['@request_quote^1', null, null]
    ],
    'ov-notes': [],
    'photos': [
      ['@add_a_photo', 'ov-media-source'],
      ['@add^1', 'ov-media-source'],
      ['@image^1', 'photo-detail', 'modal']
    ],
    'photo-detail': [
      ['@edit^1', 'image-desc', 'modal'],
      ['@delete_outline', 'BACK'],
      ['@ios_share', null]
    ],
    'cust-jobs': [
      ['@search', 'hist-search'],
      ['See details', 'job-general']
    ],
    'job-general': [
      ['@play_arrow^1', 'act:start'],
      ['12 Jobs', 'cust-jobs'],
      ['Additional information', 'ov-job-actions'],
      ['@expand_more#0', 'ov-job-actions'],
      ['@photo_camera^1', 'ov-media-source'],
      ['@image^1', 'photo-detail', 'modal'],
      ['@add^1', 'add-catalog'],
      ['@upload_file^1', 'files']
    ],
    'ov-job-actions': [
      ['@navigation^1', 'act:enroute'],
      ['@hvac^1', 'BACK'],
      ['@inventory_2^1', 'BACK'],
      ['@task_alt^1', 'act:complete']
    ],
    'rc-overview': [
      ['@play_arrow^1', 'act:start'],
      ['@history', 'rc-changes'],
      ['Household Analysis^2', 'rc-section'],
      ['Comfort Analysis^2', 'rc-section'],
      ['System Analysis^2', 'rc-furnace'],
      ['Customer Section^1', 'rc-customer'],
      ['Technician Section^1', 'rc-tech']
    ],
    'rc-section': [
      ['@history', 'rc-changes'],
      ['Save', 'act:rcSave'],
      ['@photo_camera', 'ov-media-source']
    ],
    'rc-changes': [],
    'est-empty': [
      ['@play_arrow^1', 'act:start'],
      ['@add^1', 'est-new-option', 'modal']
    ],
    'est-new-option': [
      ['Save', 'act:estSaveOption'],
      ['@add^1', 'est-catalog'],
      ['@tune^1', 'est-option', 'modal'],
      ['@note_add^1', null]
    ],
    'est-catalog': [
      ['@more_vert', 'est-custom-item', 'modal'],
      ['Done', 'act:estCatalogDone']
    ],
    'est-custom-item': [
      ['Save', 'BACK']
    ],
    'est-option': [
      ['Save', 'act:estSaveOption'],
      ['@add^1', 'est-catalog']
    ],
    'est-draft': [
      ['@play_arrow^1', 'act:start'],
      ['@visibility^1', 'est-preview', 'modal'],
      ['@more_vert', 'ov-option-menu'],
      ['@send^1', 'act:estSendReview'],
      ['Option A^1', 'est-option', 'modal'],
      ['@Add down payment', null]
    ],
    'ov-option-menu': [
      ['@edit^1', 'est-option', 'modal'],
      ['@content_copy^1', 'BACK'],
      ['@sticky_note_2^1', 'BACK'],
      ['@subject^1', 'BACK'],
      ['@mail^1', 'BACK'],
      ['@sms^1', 'BACK'],
      ['@print^1', 'BACK'],
      ['@delete_outline^1', 'BACK'],
      ['Cancel', 'BACK']
    ],
    'est-preview': [],
    'est-review': [
      ['@play_arrow^1', 'act:start'],
      ['@visibility^1', 'est-preview', 'modal'],
      ['@hourglass_top^1', 'act:estApprove']
    ],
    'est-ready': [
      ['@play_arrow^1', 'act:start'],
      ['@visibility^1', 'est-preview', 'modal'],
      ['@present_to_all^1', 'est-customer', 'modal']
    ],
    'est-customer': [
      ['@check_circle^1', 'act:estOrder']
    ],
    'est-approved': [
      ['@play_arrow^1', 'act:start'],
      ['@visibility^1', 'est-preview', 'modal'],
      ['Rejected options^1', null]
    ],
    'fin-empty': [
      ['@play_arrow^1', 'act:start'],
      ['@add^1', 'act:createInvoice'],
      ['Additional items^1', 'add-empty', 'replace'],
      ['Payments^1', 'ov-pay-method'],
      ['Invoice details^1', 'inv-details', 'modal']
    ],
    'ov-pay-method': [
      ['Credit Card^1', 'pay-card'],
      ['Cash^1', 'pay-cash'],
      ['Check^1', 'pay-check'],
      ['@smartphone^2', 'pay-apps'],
      ['Consumer financing^1', 'BACK'],
      ['@more_horiz^2', 'BACK']
    ],
    'pay-card': [
      ['@expand_more', 'ov-pay-method'],
      ['@lock^1', 'act:payDone'],
      ['@photo_camera', null]
    ],
    'pay-cash': [
      ['@expand_more', 'ov-pay-method'],
      ['@check_circle^1', 'act:payDone']
    ],
    'pay-check': [
      ['@expand_more', 'ov-pay-method'],
      ['@check_circle^1', 'act:payDone'],
      ['@photo_camera^1', 'ov-media-source'],
      ['@event', null]
    ],
    'pay-apps': [
      ['@expand_more', 'ov-pay-method'],
      ['@check_circle^1', 'act:payDone'],
      ['@event', null]
    ],
    'inv-paid': [
      ['@more_vert', 'ov-inv-share'],
      ['Change', 'inv-details', 'modal'],
      ['@mail^1', null], ['@sms^1', null], ['@print^1', null]
    ],
    'inv-sent': [
      ['@more_vert', 'ov-inv-share'],
      ['@send^1', 'ov-inv-share'],
      ['Additional items^1', 'add-items', 'replace'],
      ['Payments^1', 'ov-pay-method'],
      ['Approved estimate^1', null]
    ],
    'ov-inv-share': [
      ['@edit^1', 'inv-details', 'modal'],
      ['@mail^1', 'BACK'], ['@sms^1', 'BACK'],
      ['@preview^1', 'BACK'], ['@print^1', 'BACK']
    ],
    'history': [
      ['@search', 'hist-search'],
      ['@tune', 'hist-filters', 'modal'],
      ['Job Details', 'job-general']
    ],
    'hist-filters': [
      ['Show 14 jobs', 'BACK'],
      ['Reset', 'act:filtersReset']
    ],
    'hist-search': [
      ['@north_west^2', 'cust-jobs'],
      ['@history^1', 'cust-jobs']
    ],
    'rc-furnace': [
      ['@history', 'rc-changes'],
      ['Save', 'act:rcSave'],
      ['@photo_camera', 'ov-media-source']
    ],
    'rc-condenser': [
      ['@history', 'rc-changes'],
      ['Save', 'act:rcSave'],
      ['@photo_camera', 'ov-media-source']
    ],
    'rc-refrigerant': [
      ['@history', 'rc-changes'],
      ['Save', 'act:rcSave'],
      ['@photo_camera', 'ov-media-source']
    ],
    'rc-customer': [
      ['Save waiver', 'act:rcSave']
    ],
    'rc-tech': [
      ['Save', 'act:rcSave'],
      ['@add^1', 'ov-note-tech']
    ],
    'add-empty': [
      ['@play_arrow^1', 'act:start'],
      ['@add^1', 'add-catalog'],
      ['Payments^1', 'ov-pay-method'],
      ['Invoice details^1', 'inv-details', 'modal'],
      ['Invoices^1', null]
    ],
    'add-catalog': [
      ['Add custom item^1', 'est-custom-item', 'modal'],
      ['@add_circle_outline^1', 'est-custom-item', 'modal'],
      ['Done', 'act:addItemsDone']
    ],
    'add-items': [
      ['@play_arrow^1', 'act:start'],
      ['@add^1', 'add-catalog'],
      ['Payments^1', 'ov-pay-method'],
      ['Invoice details^1', 'inv-details', 'modal']
    ],
    'inv-details': [
      ['Save', 'BACK']
    ],
    'ov-period': [
      ['~Last week', 'BACK'], ['~Last month', 'BACK'],
      ['~Last quarter', 'BACK'], ['~Last year', 'BACK'],
      ['~Custom week', 'period-week'],
      ['~Custom month', 'ov-period-month'],
      ['~Custom quarter', 'period-quarter'],
      ['~Custom year', 'period-quarter']
    ],
    'ov-period-month': [],
    'period-quarter': [],
    'period-week': [],
    'ov-note-detailed': [],
    'ov-note-tech': [],
    'ov-note-private': [],
    'files': [
      ['@download', null],
      ['@Choose file to upload', null]
    ],
    'ov-media-source': [
      ['@photo_library^1', 'image-desc', 'modal'],
      ['@photo_camera^1', 'image-desc', 'modal'],
      ['Cancel', 'BACK']
    ],
    'image-desc': [
      ['Save', 'act:mediaSaved']
    ]
  };

  /* apply link tables */
  Object.keys(LINKS).forEach(function (id) {
    link(id, LINKS[id].filter(function (s) { return s[1] !== null && s[1] !== undefined; }));
    // explicit "inert" entries: mark as tappable but do nothing
    LINKS[id].filter(function (s) { return s[1] === null; }).forEach(function (s) {
      sel(byId(id) || document.createElement('div'), s[0]).forEach(function (e) { e.dataset.tap = '1'; });
    });
  });

  /* job tab strips */
  ['job-general', 'rc-overview', 'est-empty', 'est-draft', 'est-review',
    'est-ready', 'est-approved', 'fin-empty', 'add-empty', 'add-items', 'inv-paid', 'inv-sent']
    .forEach(wireJobTabs);

  /* the "Apply ·" buttons on the period pickers */
  ['ov-period-month', 'period-quarter', 'period-week'].forEach(function (id) {
    var root = byId(id); if (!root) return;
    $$('div', root).forEach(function (e) {
      if (/^Apply · /.test(norm(e.textContent)) && e.children.length === 0) {
        e.dataset.tap = '1'; e.dataset.act = 'applyPeriod';
      }
    });
  });
  ACT.applyPeriod = function (el) {
    var label = norm(el.textContent).replace(/^Apply · /, '');
    closeOverlays(false);
    popWhile(function (id) { return /^(period-quarter|period-week)$/.test(id); });
    toast('Period set to ' + label, 'event');
  };

  /* segmented controls */
  seg('home', ['Week', 'Month', 'Quarter', 'Year'], 1);
  seg('photos', ['All 24', 'Before 4', 'After 20'], 0);
  seg('ov-notes', ['Detailed 2', "Technician's 2", 'Private 1'], 0);
  seg('est-catalog', ['Repairs', 'Equipment', 'Ductwork', 'IAQ', 'Others'], 0);
  seg('est-new-option', ['Monthly payment + Total', 'Total only', 'Monthly payment only'], 0);
  seg('est-option', ['−20%', '0%', '+20%'], 1);
  seg('est-customer', ['Option A^1', 'Option B^1', 'Option C^1'], 0);
  seg('history', ['Today', 'Week', 'Month', 'Quarter'], 0);
  seg('pay-apps', ['Zelle', 'Venmo', 'Cash App', 'Bank'], 0);
  seg('pay-cash', ['$2,000', '$2,500', '$3,000'], 0);
  seg('image-desc', ['Before', '@check^1'], 1);
  seg('ov-period', ['~This week', '~This month', '~This quarter', '~This year'], 1, function () { setTimeout(back, 240); });
  seg('ov-period-month', ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'], 4);
  seg('period-quarter', ['Q1^1', 'Q2^1', 'Q3^1', 'Q4^1'], 2);
  seg('period-quarter', ['2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018'], 1);
  seg('period-week', ['Week 11^1', 'Week 12^1', 'Week 13^1', 'Week 14^1', 'Week 15^1', 'Week 16^1',
    'Week 17^1', 'Week 18^1', 'Week 19^1', 'Week 20^1', 'Week 21^1', 'Week 22^1'], 2);
  seg('rc-section', ['Good', 'Attention', 'Immediate'], 0);
  ['rc-furnace', 'rc-condenser', 'rc-refrigerant'].forEach(function (id) {
    seg(id, ['Furnace', 'Condenser', 'Refrigerant'], ['rc-furnace', 'rc-condenser', 'rc-refrigerant'].indexOf(id),
      function (i) { go(['rc-furnace', 'rc-condenser', 'rc-refrigerant'][i], 'replace'); });
  });

  /* checkbox / switch toggles */
  iconToggle('rc-customer', '@check_box_outline_blank', 'check_box_outline_blank', 'check_box', '#A9B4C2', '#4A6FA5');
  iconToggle('rc-refrigerant', '@check_box', 'check_box', 'check_box_outline_blank', '#16A34A', '#A9B4C2');
  var resetChips = chips('hist-filters', ['~Pending', '~Accepted'], ['Rejected']);
  switches('rc-tech');
  var resetSwitches = switches('hist-filters');

  /* US-M03-5 — work-type filter; picking one relabels the chip on Home */
  (function () {
    var chip = sel(byId('home'), '~Demand Service')[0];
    var TYPES = ['All work types', 'Demand Service', 'Maintenance', 'Estimate', 'Install'];
    seg('ov-worktype', TYPES.map(function (t) { return '~' + t; }), 1, function (i, label) {
      if (chip) chip.childNodes[0].nodeValue = TYPES[i];
      setTimeout(back, 240);
      toast(i === 0 ? 'Showing every work type' : 'Filtered to ' + TYPES[i], 'filter_alt');
    });
  })();

  /* US-M05-2 — the closeout's "need to go back" reveals which department */
  switches('closeout', function (el, isOn) {
    if (el.id !== 'ntgbSwitch') return;
    var who = byId('ntgbWho');
    if (who) who.hidden = !isOn;
  });
  (function () {
    var chips = $$('[data-ntgb]', byId('closeout'));
    if (chips.length < 2) return;
    var ON = chips[0].getAttribute('style'), OFF = chips[1].getAttribute('style');
    chips.forEach(function (c) {
      c.dataset.tap = '1';
      c.addEventListener('click', function () {
        chips.forEach(function (o) { o.setAttribute('style', o === c ? ON : OFF); });
      });
    });
  })();

  /* US-M13-2 — Reset puts the filter sheet back to its defaults */
  ACT.filtersReset = function () {
    if (resetChips) resetChips();
    if (resetSwitches) resetSwitches();
    toast('Filters reset', 'restart_alt');
  };

  /* catalogs + steppers */
  catalog('est-catalog');
  catalog('add-catalog');
  steppers('est-option', ['Adjusted total', 'Total']);
  steppers('add-items', ['Section total']);

  /* =========================================================
     US-M02-3 / US-M14-2 — connection state and the sync queue
     ========================================================= */
  var net = { online: navigator.onLine !== false, queue: 0 };
  var netbar = byId('netbar'), netmsg = byId('netmsg'), netq = byId('netq');

  function paintNet() {
    netbar.classList.toggle('on', !net.online || netbar.classList.contains('synced'));
    netq.hidden = net.queue === 0;
    netq.textContent = net.queue + (net.queue === 1 ? ' queued' : ' queued');
  }
  /* Anything the tech saves while offline joins the queue instead of failing. */
  function queued(what) {
    if (net.online) return;
    net.queue++;
    paintNet();
    return what;
  }
  function goOffline() {
    net.online = false;
    netbar.classList.remove('synced');
    $('.mi', netbar).textContent = 'cloud_off';
    netmsg.textContent = 'Offline — working from saved data';
    netbar.classList.add('on');
    paintNet();
  }
  function goOnline() {
    net.online = true;
    var had = net.queue;
    if (!had) { netbar.classList.remove('on', 'synced'); paintNet(); return; }
    // US-M14-2: queued work goes up by itself, no manual "Generate Report" step
    $('.mi', netbar).textContent = 'cloud_sync';
    netmsg.textContent = 'Back online — syncing ' + had + (had === 1 ? ' change…' : ' changes…');
    netbar.classList.add('on');
    setTimeout(function () {
      net.queue = 0;
      netbar.classList.add('synced');
      $('.mi', netbar).textContent = 'cloud_done';
      netmsg.textContent = 'All changes synced';
      paintNet();
      setTimeout(function () { netbar.classList.remove('on', 'synced'); }, 2200);
    }, 1100);
  }
  window.addEventListener('offline', goOffline);
  window.addEventListener('online', goOnline);
  if (!net.online) goOffline();

  /* =========================================================
     US-M03-9 (policy) — a technician sees only the job in front of
     them. The next one unlocks when the current one is closed out, so
     every call is treated as the only call and nobody cherry-picks.
     This is why the design's "2 of 3" pager is not wired as a pager.
     ========================================================= */
  var JOBS = [
    {
      name: 'Randy Johnson', when: 'Today, 8:00 AM', brief: 'AC not cooling', type: 'Estimate',
      addr: '5010 N Cortez Ave, Tampa, FL 33614', away: '3.92 miles away', phone: '(813) 456-7890'
    },
    {
      name: 'Brent Kenzie', when: 'Today, 11:30 AM', brief: 'AC not cooling', type: 'Maintenance',
      addr: '4407 Main St, Brandon, FL 33594', away: '11.4 miles away', phone: '(727) 415-3481'
    },
    {
      name: 'Joseph Lane', when: 'Today, 2:15 PM', brief: 'AC not cooling', type: 'Demand Service',
      addr: '255 Standish Drive, Tampa, FL 33615', away: '6.8 miles away', phone: '(352) 258-9710'
    }
  ];
  /* Overview is the tech's own figures — useful in the morning, in the way
     for the rest of the day. Collapse it and the choice sticks. */
  (function () {
    var root = byId('home'); if (!root) return;
    var head = sel(root, 'Overview')[0];
    var period = sel(root, 'Week')[0];
    var segRow = period && period.parentElement;
    var grid = $$('div', root).filter(function (e) {
      return /grid-template-columns:1fr 1fr/.test(e.getAttribute('style') || '');
    })[0];
    if (!head || !segRow || !grid) { MISS.push('home :: overview collapse'); return; }

    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '3px';
    var chev = document.createElement('span');
    chev.className = 'mi';
    chev.setAttribute('style', 'font-size:22px;color:#8A97A8');
    head.appendChild(chev);

    var KEY = 'v360.overview';
    function remembered() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
    function remember(v) { try { localStorage.setItem(KEY, v); } catch (e) { } }

    var shut = remembered() === 'collapsed';
    function paint() {
      segRow.style.display = shut ? 'none' : '';
      grid.style.display = shut ? 'none' : 'grid';
      chev.textContent = shut ? 'expand_more' : 'expand_less';
    }
    paint();
    head.dataset.tap = '1';
    head.addEventListener('click', function (ev) {
      ev.stopPropagation();
      shut = !shut;
      paint();
      remember(shut ? 'collapsed' : 'open');
    }, true);
  })();

  /* US-M04-4 — En route is a status, so the button holds the pressed state
     and releases on a second tap. */
  var paintEnroute = function () { };
  (function () {
    var btn = sel(byId('home'), '@navigation^1')[0];
    if (!btn) { MISS.push('home :: en route'); return; }
    var icon = $('.mi,.mif', btn);
    var OFF = btn.getAttribute('style');
    var ON = OFF.replace('background:#fff', 'background:#EBF0F8')
      .replace('border:1px solid #C8D5E8', 'border:1.5px solid #4A6FA5');
    paintEnroute = function () {
      btn.setAttribute('style', state.enroute ? ON : OFF);
      if (icon) icon.className = state.enroute ? 'mif' : 'mi';
    };
    paintEnroute();
  })();

  var jobIdx = 0;
  var paintJob = function () { };
  function wireCurrentJob() {
    var root = byId('home'); if (!root) return;
    var counter = sel(root, '2 of 3')[0];
    var prev = byIcon(root, 'chevron_left')[0], next = byIcon(root, 'chevron_right')[0];
    var heading = sel(root, 'Next jobs')[0];
    var refs = {
      name: sel(root, 'Randy Johnson')[0],
      when: sel(root, 'Today, 8:00 AM')[0],
      brief: sel(root, 'AC not cooling')[0],
      type: sel(root, 'Estimate')[0],
      phone: sel(root, '(123) 456-7890')[0]
    };
    // address sits in a <div>street<br><span>distance</span></div> next to the pin
    var addrRow = sel(root, '@place^1')[0];
    var addr = addrRow ? $('div', addrRow) : null;
    var awaySpan = addr ? $('span', addr) : null;
    if (!counter || !prev || !next || !heading || !addr || !awaySpan ||
      Object.keys(refs).some(function (k) { return !refs[k]; })) {
      MISS.push('home :: current job'); return;
    }

    // The whole pager goes: the arrows let a tech look ahead, and even a bare
    // "2 of 3" says more work is queued. Neither survives the policy — the
    // screen shows one job and says nothing about what comes after it.
    prev.style.display = 'none';
    next.style.display = 'none';
    counter.style.display = 'none';
    heading.textContent = 'Current job';

    paintJob = function () {
      var j = JOBS[jobIdx];
      if (!j) {
        heading.textContent = 'Nothing left today';
        return;
      }
      refs.name.textContent = j.name;
      refs.when.textContent = j.when;
      refs.brief.textContent = j.brief;
      refs.type.textContent = j.type;
      refs.phone.textContent = j.phone;
      addr.childNodes[0].nodeValue = j.addr;
      awaySpan.textContent = j.away;
    };
    paintJob();
  }
  wireCurrentJob();

  /* =========================================================
     US-M12-9 — the unsaved-changes bar shows up only once
     something actually changed
     ========================================================= */
  var RC_SCREENS = ['rc-section', 'rc-furnace', 'rc-condenser', 'rc-refrigerant', 'rc-tech'];
  var saveBars = {};
  function hideSaveBar(id) { if (saveBars[id]) saveBars[id].style.display = 'none'; }
  function showSaveBar(id) { if (saveBars[id]) saveBars[id].style.display = ''; }
  RC_SCREENS.forEach(function (id) {
    var root = byId(id); if (!root) return;
    var label = sel(root, 'You made changes to Report Card')[0];
    if (!label) { MISS.push(id + ' :: save bar'); return; }
    var bar = label.parentElement;
    saveBars[id] = bar;
    bar.style.display = 'none';
    // any edit inside the screen brings it back
    root.addEventListener('click', function (ev) {
      var t = ev.target;
      if (bar.contains(t)) return;
      if (t.closest('[data-seg]') || t.closest('.mi, .mif') || t.dataset.tap) showSaveBar(id);
    }, true);
  });

  /* =========================================================
     US-M10-2 / US-M12-6 / US-M12-7 — signatures are actually signed
     ========================================================= */
  function signaturePad(screenId, placeholder, onSign) {
    var root = byId(screenId); if (!root) return null;
    var ph = sel(root, placeholder)[0];
    if (!ph) { MISS.push(screenId + ' :: signature ' + placeholder); return null; }
    var box = ph.parentElement;
    box.classList.add('sigwrap');
    ph.classList.add('sigph');
    var cv = document.createElement('canvas');
    box.appendChild(cv);
    var ctx = null, drawing = false, signed = false, sized = false;

    /* Size on first use rather than at build time — the screen is display:none
       until it's navigated to, so it has no layout to measure before that.
       Re-size while still blank, in case the first measurement was taken
       mid-transition or with the pane collapsed. */
    function size() {
      var r = box.getBoundingClientRect();
      if (r.width < 4) return false;
      if (sized && Math.abs(r.width - cv._w) < 2) return true;
      if (sized && signed) return true;          // never wipe an existing signature
      var dpr = window.devicePixelRatio || 1;
      cv._w = r.width;
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      ctx = cv.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = '#1A2332'; ctx.lineWidth = 2.2;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      sized = true;
      return true;
    }
    function pos(e) {
      var r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }
    cv.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      if (!size() || !ctx) return;   // nothing to draw on yet — don't mark it signed
      drawing = true;
      cv.setPointerCapture(e.pointerId);
      var p = pos(e);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]);
      if (!signed) { signed = true; ph.style.opacity = '0'; if (onSign) onSign(); }
    });
    cv.addEventListener('pointermove', function (e) {
      if (!drawing || !ctx) return;
      var p = pos(e);
      ctx.lineTo(p[0], p[1]); ctx.stroke();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      cv.addEventListener(ev, function () { drawing = false; });
    });

    return {
      clear: function () {
        if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
        signed = false; ph.style.opacity = '';
      },
      isSigned: function () { return signed; }
    };
  }

  function stamp() {
    var d = new Date();
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var h = d.getHours() % 12 || 12;
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ', ' +
      h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (d.getHours() < 12 ? 'AM' : 'PM');
  }

  // customer signs the chosen estimate option — the Pending chip flips to signed
  (function () {
    var root = byId('est-customer'); if (!root) return;
    var pending = sel(root, 'Pending')[0];
    var when = sel(root, 'Oct 7, 2025, 9:09 AM')[0];
    signaturePad('est-customer', 'Sign here', function () {
      if (when) when.textContent = stamp();
      if (pending) {
        pending.textContent = 'Signed';
        pending.style.background = '#16A34A';
        pending.style.borderColor = '#16A34A';
        pending.style.color = '#fff';
      }
    });
  })();

  // Report Card waiver (49–50) and the technician's own signature (54)
  (function () {
    var root = byId('rc-customer'); if (!root) return;
    var dateEl = sel(root, 'Date: Oct 7, 2025')[0];
    var saveBtn = sel(root, 'Save waiver')[0];
    var pad = signaturePad('rc-customer', 'Customer signs here', function () {
      if (dateEl) dateEl.textContent = 'Date: ' + stamp().split(',').slice(0, 2).join(',');
      if (saveBtn) { saveBtn.style.background = '#4A6FA5'; saveBtn.style.color = '#fff'; }
    });
    var clear = sel(root, '@refresh^1')[0];
    if (clear && pad) {
      clear.dataset.tap = '1';
      clear.addEventListener('click', function (ev) {
        ev.stopPropagation(); pad.clear();
        if (saveBtn) { saveBtn.style.background = '#EDF0F5'; saveBtn.style.color = '#A9B4C2'; }
      }, true);
    }
  })();
  (function () {
    var root = byId('rc-tech'); if (!root) return;
    var by = sel(root, 'Marek Stroz · Oct 7, 2025, 4:32 PM')[0];
    signaturePad('rc-tech', 'Signed', function () {
      if (by) by.textContent = 'Marek Stroz · ' + stamp();
      showSaveBar('rc-tech');
    });
  })();

  /* =========================================================
     Auto-wiring: back arrows, close buttons, overlay scrims
     ========================================================= */
  $$('.screen,.overlay', phone).forEach(function (root) {
    if (root.classList.contains('overlay')) {
      // first child of an overlay is the dimmed scrim
      var scrim = root.firstElementChild;
      if (scrim && /position:absolute;inset:0/.test(scrim.getAttribute('style') || '')) {
        scrim.dataset.tap = '1'; scrim.dataset.go = 'BACK';
      }
    }
    byIcon(root, 'arrow_back').concat(byIcon(root, 'close')).forEach(function (e) {
      if (e.dataset.go || e.dataset.act) return;
      var t = e.parentElement && e.parentElement.dataset;
      if (t && (t.go || t.act)) return;
      e.dataset.tap = '1'; e.dataset.go = 'BACK';
      e.style.padding = '6px'; e.style.margin = '-6px';
    });
  });

  /* everything on a page that still has no handler stays inert but tappable
     where it clearly reads as a control */
  $$('.screen,.overlay', phone).forEach(function (root) {
    $$('.mi,.mif', root).forEach(function (e) {
      var n = norm(e.textContent);
      if (/^(call|place|expand_more|expand_less|chevron_right|chevron_left|more_vert|more_horiz|search|refresh|edit|download|event|info|photo_camera|add|remove)$/.test(n)) {
        if (!e.dataset.tap) e.dataset.tap = '1';
      }
    });
  });

  /* =========================================================
     Click delegation
     ========================================================= */
  document.addEventListener('click', function (ev) {
    var t = ev.target;

    var tab = t.closest && t.closest('#tabbar .tab');
    if (tab) {
      var k = tab.dataset.tab;
      go(k === 'home' ? homeScreen() : k, 'tab');
      return;
    }

    if (t.closest && t.closest('[data-close]')) { byId('sheet').classList.remove('on'); return; }

    var el = t.closest && t.closest('[data-go],[data-act],[data-back],[data-toast]');
    if (!el || !phone.contains(el)) return;

    if (el.dataset.back !== undefined) { back(); return; }
    if (el.dataset.toast) { toast(el.dataset.toast, 'info'); return; }
    if (el.dataset.act) {
      var fn = ACT[el.dataset.act];
      if (fn) fn(el); else toast('Not wired: ' + el.dataset.act, 'info');
      return;
    }
    if (el.dataset.go) go(el.dataset.go, el.dataset.mode);
  }, false);

  /* =========================================================
     Auth screens
     ========================================================= */
  byId('li-eye').addEventListener('click', function () {
    var i = byId('li-pw'), on = i.type === 'password';
    i.type = on ? 'text' : 'password';
    this.textContent = on ? 'visibility' : 'visibility_off';
  });
  byId('li-rm').addEventListener('click', function () { this.classList.toggle('on'); });

  function signIn() {
    var em = byId('li-em'), pw = byId('li-pw'), ok = true;
    var emOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.value.trim());
    em.classList.toggle('bad', !emOk); byId('li-em-e').classList.toggle('on', !emOk);
    var pwOk = pw.value.length >= 6;
    pw.classList.toggle('bad', !pwOk); byId('li-pw-e').classList.toggle('on', !pwOk);
    if (!emOk || !pwOk) return;
    var b = byId('li-go');
    b.disabled = true; b.innerHTML = '<span class="mi" style="font-size:19px">sync</span>Signing in…';
    setTimeout(function () {
      b.disabled = false; b.innerHTML = '<span class="mif" style="font-size:19px">login</span>Sign in';
      go(homeScreen(), 'root');
      toast('Welcome back, Marek', 'waving_hand');
    }, 620);
  }
  byId('li-go').addEventListener('click', signIn);
  byId('li-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
  byId('li-bio').addEventListener('click', function () {
    toast('Face ID recognised', 'fingerprint');
    setTimeout(function () { go(homeScreen(), 'root'); }, 500);
  });

  byId('fg-go').addEventListener('click', function () {
    var em = byId('fg-em');
    var ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.value.trim());
    em.classList.toggle('bad', !ok); byId('fg-em-e').classList.toggle('on', !ok);
    if (!ok) return;
    go('otp', 'push'); startOtpTimer(); toast('Code sent to (813) ••• 4471', 'sms');
  });

  var otpTimer;
  function startOtpTimer() {
    var left = 29;
    byId('otp-rs').innerHTML = 'Resend in <span id="otp-t">0:29</span>';
    clearInterval(otpTimer);
    otpTimer = setInterval(function () {
      left--;
      var t = byId('otp-t');
      if (left <= 0) { clearInterval(otpTimer); byId('otp-rs').textContent = 'Resend code'; return; }
      if (t) t.textContent = '0:' + (left < 10 ? '0' : '') + left;
    }, 1000);
  }
  byId('otp-rs').addEventListener('click', function () {
    if (/Resend code/.test(this.textContent)) { startOtpTimer(); toast('New code sent', 'sms'); }
  });
  var digits = $$('.otp-d');
  digits.forEach(function (d, i) {
    d.addEventListener('input', function () {
      this.value = this.value.replace(/\D/g, '').slice(0, 1);
      if (this.value && digits[i + 1]) digits[i + 1].focus();
      byId('otp-e').classList.remove('on');
    });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !this.value && digits[i - 1]) digits[i - 1].focus();
      if (e.key === 'Enter') byId('otp-go').click();
    });
  });
  byId('otp-go').addEventListener('click', function () {
    var full = digits.every(function (d) { return d.value; });
    byId('otp-e').classList.toggle('on', !full);
    if (!full) { digits.forEach(function (d) { if (!d.value) d.classList.add('bad'); }); return; }
    clearInterval(otpTimer);
    go('newpass', 'push');
  });

  function strength(v) {
    var n = 0;
    if (v.length >= 8) n++;
    if (/\d/.test(v)) n++;
    if (/[^A-Za-z0-9]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v))) n++;
    return n;
  }
  byId('np-a').addEventListener('input', function () {
    var n = strength(this.value);
    var cols = ['#EDF0F5', '#DC2626', '#D97706', '#16A34A'];
    var names = ['&mdash; &nbsp;', 'Weak', 'Fair', 'Strong'];
    $$('.np-seg').forEach(function (s, i) { s.style.background = i < n ? cols[n] : '#EDF0F5'; });
    byId('np-str').innerHTML = 'Strength &mdash; <b style="font-weight:600;color:' + (n ? cols[n] : '#8A97A8') + '">' + names[n] + '</b>';
  });
  byId('np-go').addEventListener('click', function () {
    var a = byId('np-a'), b = byId('np-b');
    var ok = a.value.length >= 8 && /\d/.test(a.value) && a.value === b.value;
    byId('np-e').classList.toggle('on', !ok);
    byId('np-e').textContent = a.value.length < 8 ? 'At least 8 characters with one number.'
      : (a.value !== b.value ? 'Passwords don’t match yet.' : '');
    b.classList.toggle('bad', !ok);
    if (!ok) return;
    go('login', 'root');
    toast('Password updated — sign in again', 'lock_reset');
  });

  byId('logout').addEventListener('click', function () { ACT.logout(); });

  /* chat compose */
  function send() {
    var i = byId('msg'), v = i.value.trim(); if (!v) return;
    var th = byId('thread');
    var b = document.createElement('div');
    b.setAttribute('style', 'max-width:76%;align-self:flex-end;background:#4A6FA5;border-radius:14px 14px 4px 14px;padding:11px 13px');
    b.innerHTML = '<div style="font:400 14.5px/1.45 Geist;color:#fff"></div>' +
      '<div style="font:400 11px/1 Geist;color:#C9D8EE;margin-top:7px">Now · Sent</div>';
    b.firstChild.textContent = v;
    th.appendChild(b); i.value = ''; th.scrollTop = th.scrollHeight;
  }
  byId('msgSend').addEventListener('click', send);
  byId('msg').addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

  /* =========================================================
     Screen index + flows
     ========================================================= */
  var SECT = {
    auth: 'Sign in', home: 'Home & dashboard', job: 'Job', estimate: 'Estimate — build',
    'estimate-states': 'Estimate — states', finance: 'Finance & payment',
    'finance-2': 'Invoice & extras', history: 'Jobs history', 'rc-system': 'Report Card — sections',
    'home-2': 'Period pickers', 'notes-media': 'Notes & media', app: 'App shell'
  };
  var MY = [
    { id: 'splash', title: 'Splash', section: 'auth', desc: 'Boot screen' },
    { id: 'login', title: 'Sign in', section: 'auth', desc: 'Email + password, Face ID' },
    { id: 'forgot', title: 'Reset password', section: 'auth', desc: 'Request a code' },
    { id: 'otp', title: 'Enter code', section: 'auth', desc: '6-digit SMS code' },
    { id: 'newpass', title: 'New password', section: 'auth', desc: 'With strength meter' },
    { id: 'chat', title: 'Chat', section: 'app', desc: 'Conversations, 3 unread' },
    { id: 'chat-thread', title: 'Chat thread', section: 'app', desc: 'Dispatch — live compose' },
    { id: 'timesheet', title: 'Timesheet', section: 'app', desc: 'Clocked-in timer, week' },
    { id: 'more', title: 'More', section: 'app', desc: 'Profile, sync, log out' }
  ];
  function buildIndex() {
    var all = MY.concat(META.map(function (m) {
      return { id: m.id, title: m.title, section: m.section, desc: m.desc };
    }));
    var groups = {};
    all.forEach(function (s) { (groups[s.section] = groups[s.section] || []).push(s); });
    var order = ['auth', 'home', 'job', 'estimate', 'estimate-states', 'finance', 'finance-2',
      'rc-system', 'history', 'home-2', 'notes-media', 'app'];
    var html = '', n = 0;
    order.forEach(function (k) {
      if (!groups[k]) return;
      html += '<div class="grp">' + (SECT[k] || k) + '</div>';
      groups[k].forEach(function (s) {
        n++;
        html += '<div class="it" data-jump="' + s.id + '"><span class="n">' + n + '</span>' +
          '<span class="tx">' + s.title + (s.desc ? '<small>' + s.desc + '</small>' : '') + '</span></div>';
      });
    });
    byId('sheetBody').innerHTML = html;
  }
  buildIndex();
  byId('indexBtn').addEventListener('click', function () {
    byId('sheet').classList.add('on');
    var c = curPage();
    $$('#sheetBody .it').forEach(function (e) { e.classList.toggle('cur', e.dataset.jump === c); });
  });
  byId('sheetBody').addEventListener('click', function (ev) {
    var it = ev.target.closest('[data-jump]'); if (!it) return;
    byId('sheet').classList.remove('on');
    var id = it.dataset.jump;
    if (isOv(id)) {
      var base = { 'ov-notes': 'job-general', 'ov-job-actions': 'job-general', 'ov-option-menu': 'est-draft', 'ov-pay-method': 'fin-empty', 'ov-inv-share': 'inv-sent', 'ov-period': 'home', 'ov-period-month': 'home', 'ov-note-detailed': 'job-general', 'ov-note-tech': 'job-general', 'ov-note-private': 'job-general', 'ov-media-source': 'home-active' }[id] || 'home';
      go(base, 'root'); setTimeout(function () { go(id); }, 60);
    } else go(id, 'root');
  });

  /* dev mode: the screen index is hidden until you ask for it —
     press "/" on a keyboard, or triple-tap the status bar on a phone. */
  function devToggle(open) {
    document.body.classList.toggle('dev', open === undefined ? undefined : open);
    if (document.body.classList.contains('dev')) byId('indexBtn').click();
    else byId('sheet').classList.remove('on');
  }
  var taps = [];
  $('.statusbar').addEventListener('click', function () {
    var now = Date.now();
    taps = taps.filter(function (t) { return now - t < 700; });
    taps.push(now);
    if (taps.length >= 3) { taps = []; devToggle(); }
  });

  /* keyboard */
  document.addEventListener('keydown', function (e) {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); back(); }
    if (e.key === 'Escape') byId('sheet').classList.remove('on');
    if (e.key === '/') { e.preventDefault(); devToggle(); }
  });

  /* clock */
  function tick() {
    var d = new Date();
    var h = d.getHours() % 12 || 12;
    byId('clock').textContent = h + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  tick(); setInterval(tick, 15000);

  /* timesheet running clock */
  var tsSec = 6 * 3600 + 41 * 60 + 12;
  setInterval(function () {
    tsSec++;
    var el = byId('tsClock'); if (!el) return;
    var h = Math.floor(tsSec / 3600), m = Math.floor(tsSec % 3600 / 60), s = tsSec % 60;
    el.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }, 1000);

  /* ---------- boot ---------- */
  function boot() {
    stack = [{ id: 'splash', mode: 'root' }];
    $$('.screen,.overlay', phone).forEach(function (e) { e.classList.remove('on', 'leaving'); });
    byId('splash').classList.add('on');
    chrome();
    setTimeout(function () { byId('splashBar').style.width = '100%'; }, 120);
    setTimeout(function () { go('login', 'replace'); }, 1600);
  }
  boot();

  if (MISS.length) console.warn('[proto] unmatched selectors (' + MISS.length + '):\n' + MISS.join('\n'));

  /* A misspelled icon name has no ligature, so the font renders the raw string
     and blows the row's layout apart. Catch it once the font is in. */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;font-size:24px;white-space:nowrap';
      document.body.appendChild(probe);
      var seen = {}, broken = [];
      $$('.mi,.mif', phone).forEach(function (e) {
        var n = norm(e.textContent), cls = e.className;
        if (!/^[a-z0-9_]+$/.test(n) || seen[cls + n]) return;
        seen[cls + n] = 1;
        probe.className = cls;
        probe.textContent = n;
        if (probe.getBoundingClientRect().width > 34) broken.push(n + ' (' + cls + ')');
      });
      probe.remove();
      if (broken.length) console.warn('[proto] icon names with no glyph:\n' + broken.join('\n'));
    });
  }
  window.__proto = { go: go, back: back, state: state, miss: MISS };
})();
