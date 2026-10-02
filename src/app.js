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

  /* =========================================================
     Local store. This is a field app: what the tech enters has to survive
     a dead battery, a closed tab and a day with no signal. Static hosting
     has no server of ours, so the device is the store — the same
     offline-first shape the technicians asked for. One versioned key;
     every write is small and immediate.
     ========================================================= */
  var DB_KEY = 'v360.data.v1';
  var db = (function () {
    try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}') || {}; } catch (e) { return {}; }
  })();
  function saveDb() { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { } }
  function remember(key, val) { db[key] = val; saveDb(); }
  function recall(key, dflt) { return Object.prototype.hasOwnProperty.call(db, key) ? db[key] : dflt; }
  function forgetAll() { db = {}; try { localStorage.removeItem(DB_KEY); localStorage.removeItem('v360.overview'); } catch (e) { } }

  /* App data that boot-time code reads. It sits up here, above every block
     that could touch it, because `var` hoists the name and not the value —
     declared any later, a restore that runs at boot would find `undefined`.
     Two bugs in this file came from exactly that. */
  /* The customer's signature on the option sheet. Declared up here with the
     rest of the boot-time state, because the action that reads it is defined
     far above the pad that sets it. */
  var estSigned = false;
  var estSignedAt = '';          // the moment the customer actually signed
  var estPresented = false;      // the customer sheet was actually opened
  var payMethod = '';            // which way the money came in, if it did
  var photosThisVisit = 0;       // proof for the install crew, reset per job
  var goBacks = [];              // return visits raised at close-out, for dispatch

  /* =========================================================
     Plan selection: the monthly figure the customer is shown.

     It was four read-only tiles, a dropdown that did not drop and an
     "Add down payment" that did nothing — sitting under a heading that
     never said what any of it was for. Meanwhile every "/month" on the
     option cards was a number typed into the mock-up.

     A plan is a rate and a term; the monthly payment follows from those
     and the amount financed, by the ordinary amortisation formula. Pick
     a different plan or put money down and every monthly figure in the
     estimate moves, because they are all the same calculation.

     The board's own default reconciles at 24 months, not the 12 its tile
     claimed: $1,109 at 7.99% over 24 gives $50.15, which is the $50.20
     it drew. The term was the typo, so the term is what changed.
     ========================================================= */
  var PLANS = [
    { name: 'Ally', rate: 7.99, apr: 8.35, months: 24 },
    { name: 'Synchrony', rate: 9.99, apr: 10.4, months: 36 },
    { name: 'GreenSky', rate: 6.99, apr: 7.25, months: 12 },
    { name: 'Pay in full', rate: 0, apr: 0, months: 0 }
  ];
  var planIdx = 0;
  var deposit = 0;                    // what the customer hands over on the day

  function plan() { return PLANS[planIdx]; }
  // payment per dollar financed — what the card calls the monthly factor
  function planFactor() {
    var p = plan();
    if (!p.months) return 0;
    var r = p.rate / 100 / 12;
    if (!r) return 1 / p.months;
    return r / (1 - Math.pow(1 + r, -p.months));
  }
  function monthlyFor(total) {
    if (!plan().months) return 0;
    return Math.max(0, total - deposit) * planFactor();   // a deposit under the total is financed
  }
  var MONTHLY_FACTOR = 0.0129;        // kept for anything still reading it directly

  // filled by the job-header pass, read by the paint that swaps Start for
  // Complete — both run long before this file's midpoint
  var jobHeaderBtns = [];

  var RATING = ['Good', 'Attention', 'Immediate'];   // the Report Card's three-state control
  var RC_GROUPS = {                                   // overview badges: design baseline + what the tech changes
    'Household Analysis': { base: 4, screens: ['rc-section'] },
    'System Analysis': { base: 4, screens: ['rc-furnace', 'rc-condenser', 'rc-refrigerant'] }
  };

  /* Lift overlays out of the scrolling viewport into the phone itself, so a
     bottom sheet dims and covers the status bar and tab bar too. */
  var ovLayer = document.createElement('div');
  ovLayer.id = 'overlays';
  phone.appendChild(ovLayer);
  $$('.overlay', viewport).forEach(function (el) { ovLayer.appendChild(el); });
  phone.appendChild(byId('toast'));   // toasts sit above sheets

  /* The running clock said "On site" on one screen only. Open Job Details
     and the last thing telling you a job was still going disappeared —
     which is exactly when you want to know you haven't already closed it
     out. It isn't a screen's banner, it's the phone's: it sits under the
     status bar with the connection line, and shows for as long as the
     clock runs, wherever you are. */
  var onsiteBar = (function () {
    var active = byId('home-active');
    var bar = active && active.children[0];
    if (!bar || !/background:#16A34A/.test(bar.getAttribute('style') || '')) {
      MISS.push('home-active :: on-site bar');
      return null;
    }
    bar.dataset.tap = '1';
    bar.dataset.go = 'job-general';        // it was tappable where it used to live
    phone.insertBefore(bar, viewport);
    return bar;
  })();

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
    paused: false,      // on the job, off the clock — lunch, a parts run
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
    if (id === 'image-desc') { paintSlotBanner(); paintMediaForm(); }
    if (id === 'closeout') paintCloseout();
    if (PAY_SCREENS.indexOf(id) > -1) paintPayScreens();
    // a notes sheet opens at the top of its list, not where it was left
    if (id.indexOf('ov-note-') === 0) { var nl = $('.sc', el); if (nl) nl.scrollTop = 0; }
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
    // the stage the tech moved this job to belongs to the job, not the session
    if (typeof JOBS !== 'undefined' && JOBS[jobIdx] && pid !== 'login') {
      JOBS[jobIdx].est = state.est;
      JOBS[jobIdx].inv = state.inv;
      // every navigation is a checkpoint
      remember('state', state);
      remember('jobIdx', jobIdx);
      remember('jobs', JOBS.map(function (j) {
        return { est: j.est, inv: j.inv, items: j.items, sold: j.sold, done: !!j.done };
      }));
    }
    paintDash();
    paintCard();
    paintStartButtons();
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

  /* Hiding by writing style.display='none' and restoring with '' deletes the
     element's own display, so a flex row comes back as a block and the layout
     falls apart. Remember what it was. */
  function toggleDisplay(el, show) {
    if (!el) return;
    if (el.dataset.disp === undefined) el.dataset.disp = el.style.display || '';
    el.style.display = show ? el.dataset.disp : 'none';
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
    function paint(i, silent) {
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
      if (onPick && !silent) onPick(i, labels[i], els[i]);
    }
    function setIcon(el, spec) { if (!el) return; el.textContent = spec[0]; el.className = spec[1]; el.setAttribute('style', spec[2]); }
    els.forEach(function (e, i) {
      e.dataset.tap = '1';
      e.dataset.seg = '1';
      e.addEventListener('click', function (ev) { ev.stopPropagation(); paint(i); }, true);
    });
    /* A caller that keeps the control in step with something else needs to
       be able to move it without being called back about it: fn(i) selects
       silently, fn() puts it back where it started. The dashboard's period
       has been asking for this and quietly getting undefined. */
    return function (i) { paint(typeof i === 'number' ? i : active, true); };
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
    // no argument resets to the design's own choice; an index selects one
    // without calling back, so a painter can mirror state into the control
    return function (i) {
      if (i === undefined || i < 0) { found.forEach(function (fn) { fn(); }); return; }
      paint(i, true);
    };
  }

  /* ---------- catalog Add / Added pills ---------- */
  function money(s) { var m = String(s).replace(/[^0-9.]/g, ''); return parseFloat(m) || 0; }
  function fmt(n) { return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function catalog(id) {
    var root = byId(id); if (!root) return null;
    var addPills = sel(root, '@add^1'), donePills = sel(root, '@check^1');
    if (!addPills.length || !donePills.length) { MISS.push(id + ' :: catalog pills'); return null; }
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
    /* Add / Added answered the wrong question. Four filters is a quantity,
       and the only place to say four was the option screen, two taps back —
       so the technician added the filter, left, changed the number, and came
       back for the next item. Adding gives you the number to change, where
       you are; taking it to zero puts the item back on the shelf. */
    var STEP = 'display:inline-flex;align-items:center;gap:1px;background:#E7F6EC;' +
      'border:1px solid #16A34A;border-radius:9px;padding:2px';
    var STEPBTN = 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;' +
      'color:#15803D;font-size:19px';
    var QTYSTYLE = 'min-width:24px;text-align:center;font:700 14px/1 Geist;color:#15803D;' +
      'font-variant-numeric:tabular-nums';

    function rowOf(p) {
      return p.closest('div[style*="border-radius:12px"]');
    }
    function qtyOf(p) { return parseInt(p.dataset.qty || '0', 10) || 0; }
    function recount() {
      var n = 0, sum = 0;
      pills.forEach(function (p) { var q = qtyOf(p); n += q; sum += q * priceOf(p); });
      base.n = n; base.sum = sum;
      render();
    }
    function setQty(p, q) {
      q = Math.max(0, q);
      p.dataset.qty = String(q);
      p.dataset.on = q > 0 ? '1' : '0';
      if (q > 0) {
        p.setAttribute('style', STEP);
        p.innerHTML = '<span class="mi" data-qminus style="' + STEPBTN + '">remove</span>' +
          '<span data-qty style="' + QTYSTYLE + '">' + q + '</span>' +
          '<span class="mi" data-qplus style="' + STEPBTN + '">add</span>';
      } else {
        p.setAttribute('style', ADD.style);
        p.innerHTML = ADD.html;
      }
      var row = rowOf(p);
      // the board left a green border on rows whose pill had gone back to Add
      if (row) row.style.border = q > 0 ? '1.5px solid #16A34A' : '1px solid #DDE3EE';
      recount();
    }

    pills.forEach(function (p) {
      p.dataset.tap = '1';
      // nothing is in the option until the technician puts it there
      setQty(p, 0);
      p.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var q = qtyOf(p);
        if (q === 0) q = 1;
        else if (ev.target.closest('[data-qplus]')) q += 1;
        else if (ev.target.closest('[data-qminus]')) q -= 1;
        else return;                       // the number itself is not a button
        p.classList.add('press');
        setTimeout(function () { p.classList.remove('press'); }, 200);
        setQty(p, q);
      }, true);
    });

    /* What the tech actually ticked, so it can be carried into the option. */
    return {
      selection: function () {
        return pills.filter(function (p) { return qtyOf(p) > 0; }).map(function (p) {
          var row = p.parentElement.parentElement;      // right column → the flex row
          var left = row.firstElementChild;
          var texts = $$('div', left).map(function (d) { return norm(d.textContent); });
          var known = BY_NAME[texts[0]];
          return {
            sku: known ? known.sku : '',
            name: texts[0] || 'Item',
            desc: texts[1] || '',
            warranty: texts[2] || '',
            price: priceOf(p),
            // every item carries its own type and category — Marek, Sep 10
            type: known ? known.type : 'service',
            cat: known ? known.cat : '',
            labor: known ? known.labor : 0,
            qty: qtyOf(p)
          };
        });
      },
      clear: function () { pills.forEach(function (p) { setQty(p, 0); }); }
    };
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
    jobNotes: function () { go('job-notes', 'replace'); },
    jobRC: function () { go('rc-overview', 'replace'); },
    jobEst: function () { go(estScreen(), 'replace'); },
    jobFin: function () { go(finScreen(), 'replace'); },

    /* Stopping the clock is not finishing the job. A tech breaks for lunch,
       drives for a part, waits on the customer — and the old button went
       straight to the close-out, which is a twelve-field form and the end of
       the visit. Pause holds the job open with the clock stopped; the way
       out is Complete, next to it. */
    pauseJob: function () {
      if (!state.onsite) return;
      state.paused = !state.paused;
      setClock(state.paused ? 'off' : 'work');
      paintEnroute();
      paintOnsiteBar();
      queued('Job status');
      toast(state.paused ? 'Paused — the clock has stopped' : 'Back on the clock',
        state.paused ? 'pause_circle' : 'play_circle');
    },
    start: function () {
      state.onsite = true;
      state.paused = false;
      state.enroute = false;          // you've arrived — the en route state is spent
      paintEnroute();
      paintJob();
      setClock('work');
      go('home-active', 'root');
      queued('Job status');
      toast('Job started · timer running', 'play_circle');
    },
    enroute: function () {
      state.enroute = !state.enroute;
      paintEnroute();
      paintJob();
      setClock(state.enroute ? 'drive' : (state.onsite ? 'work' : 'off'));
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

    newOption: function () {
      if (optCount >= MAX_OPTIONS) {
        toast('Maximum ' + MAX_OPTIONS + ' options per job', 'block');
        return;
      }
      optionItems = [];              // a new option starts empty
      optAdjust = 0;
      renderOptionItems();
      paintOptionName();
      go('est-new-option', 'modal');
    },
    estSaveOption: function () {
      if (!optionItems.length) {
        toast('Add at least one item before saving the option', 'info');
        return;
      }
      var first = state.est === 'none';
      state.est = 'draft';
      var total = optionAdjusted();
      var added = first ? true : addOption(total, optionItems);
      if (optionNoteText) {
        optionNotes['Option ' + String.fromCharCode(65 + Math.max(0, optCount - 1))] = optionNoteText;
        optionNoteText = '';
      }
      optionItems = [];
      optAdjust = 0;
      renderOptionItems();
      paintOptionName();
      go('est-draft', 'root');
      queued('Estimate');
      toast(added ? 'Option saved to draft estimate' : 'Maximum ' + MAX_OPTIONS + ' options per job');
    },
    estSendReview: function () {
      // however many options were built, they go up — four is the ceiling,
      // not a quota, and an estimate with two is still an estimate
      if (!optCount) {
        toast('Add an option before sending it for review', 'info');
        return;
      }
      state.est = 'review';
      go('est-review', 'replace');
      queued('Estimate');
      toast('Sent to your manager for review', 'send');
    },
    estApprove: function () { state.est = 'ready'; go('est-ready', 'replace'); toast('Manager approved — ready to present', 'verified'); },
    estOrder: function () {
      if (!estSigned) {
        // the button already says this; the toast says why

        toast('The customer signs first — that signature is the order', 'draw');
        return;
      }
      var pick = pickedOption;
      var total = OPTION_TOTALS[pick] || 0;
      var j = JOBS[jobIdx];
      state.est = 'approved';
      paintApproved();
      if (j) {
        j.sold = { option: pick, total: total };
        /* Marek: the items on the approved option are the job's items. Nobody
           retypes them — an approval that doesn't carry its own items leaves
           the crew working from a number. */
        j.items = mergeItems(j.items || [], (OPTION_ITEMS[pick] || []).map(function (it) {
          var c = {}; for (var k in it) c[k] = it[k];
          c.from = 'estimate';
          return c;
        }));
      }
      renderJobItems();
      kpiSale(total);                              // the dashboard on Home moves
      closeOverlays(true);
      go('est-approved', 'root');
      queued('Estimate');
      toast('Order confirmed · ' + pick + ' signed — ' + fmt(total), 'check_circle');
    },
    estDecline: function () {
      state.est = 'ready';                 // still presentable — that's the fix
      markDeclined();
      closeOverlays(true);
      go('est-ready', 'root');
      queued('Estimate');
      // a decline with a date on it is a visit; without one it is a shrug
      toast(followUpDays >= 0
        ? 'Declined — follow up on ' + followDate(followUpDays)
        : 'Declined — estimate stays open, no follow-up date set',
        'history_toggle_off');
    },
    reinvoice: function () {
      state.inv = 'none';                  // a second invoice on the same job
      go('fin-empty', 'root');
      toast('Start a new invoice for this job', 'note_add');
    },
    optAddItem: function () { catalogTarget = 'option'; go('est-catalog', 'push'); },
    jobAddItem: function () {
      catalogTarget = 'job';
      // the design draws two items already ticked. On the estimate that is a
      // state worth keeping; on a job it would quietly bill the customer for
      // two things the technician never chose, so this opens empty.
      if (estCatalog) estCatalog.clear();
      go('est-catalog', 'modal');
    },
    estCatalogDone: function () {
      var picked = estCatalog ? estCatalog.selection() : [];
      if (estCatalog) estCatalog.clear();
      if (catalogTarget === 'job') { jobAddPicked(picked); return; }
      picked.forEach(function (it) {
        var n = it.qty || 1;
        var seen = optionItems.filter(function (o) { return o.name === it.name; })[0];
        if (seen) seen.qty += n;                    // the same item again is a quantity, not a row
        else optionItems.push({
          sku: it.sku, name: it.name, desc: it.desc, warranty: it.warranty,
          price: it.price, type: it.type, cat: it.cat, labor: it.labor,
          qty: n
        });
      });
      renderOptionItems();
      back();
      toast(picked.length ? picked.length + (picked.length === 1 ? ' item added' : ' items added') + ' to the option'
        : 'Nothing selected', picked.length ? 'check_circle' : 'info');
    },

    createInvoice: function () { state.inv = 'sent'; go('inv-sent', 'replace'); toast('Invoice INV-26-03-123 created & sent', 'receipt_long'); },
    payDone: function () {
      if (curPage() === 'pay-card' && !net.online) {
        toast('No signal — the card can’t be charged yet', 'cloud_off');
        return;
      }
      state.inv = 'paid';
      payMethod = PAY_LABEL[curPage()] || 'Card';
      kpiPaid(payAmount);                           // what was actually collected lands in Revenue
      closeOverlays(true);
      go('inv-paid', 'root');
      queued('Payment');
      toast(net.online ? 'Payment received · ' + fmt(payAmount)
        : 'Payment recorded offline · will post when you have signal');
    },
    addItemsDone: function () { state.extra = true; go('add-items', 'replace'); toast('2 items added to the invoice'); },

    rcSave: function (el) {
      var scr = el.closest('.screen');
      if (scr) hideSaveBar(scr.id);
      queued('Report Card');
      // the sections open where they are now, so saving one is not a way out
      if (!scr || scr.id !== 'rc-overview') back();
      toast(net.online ? 'Report Card saved' : 'Report Card saved locally — will sync');
    },
    present: function () { estPresented = true; go('est-customer', 'modal'); },
    histMenu: function (el) {
      histJob = el.dataset.job || '';
      var nm = byId('histJobName');
      if (nm) nm.textContent = histJob;
      go('ov-histjob', 'overlay');
    },
    /* Closed out, and then the customer catches you at the fence. The work
       that follows belongs to the visit that just ended, not to a new one,
       so the job goes back on the list rather than being raised again. The
       clock is not started for them — they may only be fetching a part. */
    histReopen: function () {
      var at = -1;
      for (var i = 0; i < JOBS.length; i++) if (JOBS[i].name === histJob) at = i;
      closeOverlays(true);
      if (at < 0) { toast(histJob + ' is not on this device', 'info'); return; }
      if (!JOBS[at].done) { toast(histJob + ' is already on your list', 'info'); return; }
      JOBS[at].done = false;
      jobIdx = at;
      loadJob();
      paintJob();
      paintCard();
      go('home', 'root');
      queued('Job status');
      toast(histJob + ' is back on your list — press Start when you are back inside',
        'restart_alt');
    },
    pickGallery: function () {
      galClear();
      closeOverlays(false);
      go('gallery', 'modal');
    },
    useCamera: function () {
      mediaBatch = 1;
      mediaEditing = false;
      closeOverlays(false);
      go('image-desc', 'modal');
    },
    mediaDescribe: function () { mediaEditing = true; go('image-desc', 'modal'); },
    mediaMarkup: function () { toast('Markup opens in the phone\'s photo editor', 'gesture'); },
    mediaDownload: function () { toast('Saved to your photos', 'download'); },
    galDone: function () {
      if (!galPicked.length) return;
      mediaBatch = galPicked.length;
      mediaEditing = false;
      go('image-desc', 'replace');
    },
    mediaSaved: function () {
      var bound = pendingSlot;
      var n = Math.max(1, mediaBatch);
      var wasEditing = mediaEditing;
      mediaEditing = false;
      if (bound) {
        markSlotFilled(bound);
        pendingSlot = null;
      }
      addMediaThumbs(n);
      // only a single photo was asked for a type, so only it carries one
      var typed = (wasEditing || n === 1) ? photoType : '';
      addPhotoTiles(n, typed);
      // Other is a real answer and has no chip of its own, so it moves only
      // the total — the three chips never claim a photo they do not have
      if (typed && photoTypeCount[typed] !== undefined) {
        photoTypeCount[typed] += n;
        remember('photoTypeCount', photoTypeCount);
        paintTypeCounts();
      }
      photosThisVisit += n;
      mediaBatch = 1;
      /* Saving used to drop the tech back wherever they happened to have
         come from, which after a camera shot is a screen with no sign of
         the photo on it. Land where the photo now lives: on the slot it was
         shot for, on the photo being described, or on the list it just
         joined — where it is the first tile. */
      if (bound || wasEditing) back(); else go('photos', 'replace');
      // the install card is counting these photos, and neither back() nor a
      // replace runs its paint
      paintInstall();
      startUpload(n, bound);
      toast(bound
        ? 'Photo filed against slot ' + bound.slot
        : n + ' ' + plural(n) + ' saved',
        'photo_camera');
    },
    // "Set to Completed" runs the SOP closeout first — the job isn't done
    // until the twelve fields are in (US-M05-2)
    complete: function () {
      closeOverlays(true);
      paintCloseoutBlocker();
      go('closeout', 'modal');
    },
    closeoutSave: function () {
      queued('Closeout');
      back();
      toast(net.online ? 'Closeout saved' : 'Closeout saved — will sync', 'save');
    },
    closeoutComplete: function () {
      // The office is blind until the photos land, and once the next call is
      // unlocked nobody comes back to this one. With signal, a stuck upload
      // stops the close; with no signal it's queued and that's fine.
      if (upPending > 0 && net.online) {
        paintCloseoutBlocker();
        toast(upPending + ' ' + plural(upPending) + ' still uploading — wait for it', 'sync');
        return;
      }
      if (ntgbOn() && !ntgbWho) {
        toast('Say which department goes back', 'groups');
        return;
      }
      var gaps = installMissing();
      if (gaps.length) {
        paintInstall();
        toast('An install was sold — still missing ' + gaps.join(', '), 'handyman');
        return;
      }
      if (ntgbOn()) {
        // dispatch picks this up as a job of its own, against this customer
        goBacks.push({
          dept: ntgbWho, customer: (JOBS[jobIdx] || {}).name || '',
          addr: (JOBS[jobIdx] || {}).addr || '', when: noteStamp()
        });
        remember('goBacks', goBacks);
        queued('Go-back');
      }
      setClock('off');
      clock.visits++;
      var done = JOBS[jobIdx];
      if (state.est === 'approved' && done && done.sold) clock.sold += done.sold.total;
      // compensation splits: labour is earned on the items, commission on the sale
      clock.labor += jobLabor(done);
      clock.commission += (done && done.sold ? done.sold.total : 0) * COMMISSION_RATE;
      paintClock();
      remember('clock', clock);
      // the closeout form belongs to the visit that just ended
      $$('#closeout .co-f').forEach(function (f) { f.value = f.tagName === 'TEXTAREA' ? '' : f.defaultValue; });
      remember('closeout', []);
      var sentBack = ntgbOn() ? ntgbWho : '';
      resetNtgb();
      estPresented = false;
      payMethod = '';
      photosThisVisit = 0;
      state.onsite = false;
      state.paused = false;
      state.enroute = false;
      state.extra = false;
      paintEnroute();
      // the queue can be browsed now, so a finished job is struck off it
      // rather than left behind a cursor
      if (JOBS[jobIdx]) JOBS[jobIdx].done = true;
      var left = openJobs();
      jobIdx = left.length ? left[0] : JOBS.length;
      loadJob();
      paintJob();
      closeOverlays(true);
      go('home', 'root');
      queued('Job status');
      toast(sentBack
        ? 'Job closed — go-back for ' + sentBack + ' sent to dispatch'
        : upPending
          ? 'Job closed — ' + upPending + ' ' + plural(upPending) + ' will upload on signal'
          : (JOBS[jobIdx] ? 'Job closed — next one unlocked' : 'Job closed — nothing left today'),
        sentBack ? 'assignment_return' : 'task_alt');
    },
    resetDemo: function () {
      forgetAll();
      toast('Demo reset — starting clean', 'restart_alt');
      setTimeout(function () { location.reload(); }, 600);
    },
    logout: function () {
      state = { onsite: false, enroute: false, est: 'none', inv: 'none', extra: false };
      remember('signedIn', false);
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
    // the card here is the one from Home, moved in while a job runs, so it
    // arrives already wired — only Quick add belongs to this screen
    'home-active': [
      ['@photo_camera^1', 'ov-media-source'],
      ['@edit_note^1', 'ov-note-tech'],
      ['@fact_check^1', 'rc-overview'],
      ['@request_quote^1', 'act:jobEst']
    ],
    'job-notes': [
      ['@play_arrow^1', 'act:start']
    ],
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
      ['@photo_camera^1', 'ov-media-source'],
      ['@image^1', 'photo-detail', 'modal'],
      ['@add^1', 'act:jobAddItem'],
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
      ['@add^1', 'act:newOption']
    ],
    'est-new-option': [
      ['Save', 'act:estSaveOption'],
      ['@add^1', 'act:optAddItem'],
      ['@tune^1', 'act:adjustPrice'],
      ['@note_add^1', 'act:optionNote']
    ],
    'est-catalog': [
      ['Add custom item^1', 'est-custom-item', 'modal'],
      ['@add_circle_outline^1', 'est-custom-item', 'modal'],
      ['Done', 'act:estCatalogDone']
    ],
    'est-custom-item': [
      ['Save', 'BACK']
    ],
    'est-option': [
      ['Save', 'act:estSaveOption'],
      ['@add^1', 'act:optAddItem']
    ],
    'est-draft': [
      ['@play_arrow^1', 'act:start'],
      ['@visibility^1', 'est-preview', 'modal'],
      ['@more_vert', 'ov-option-menu'],
      ['@send^1', 'act:estSendReview'],
      ['Option A^1', 'est-option', 'modal'],
      ['~Add new option', 'act:newOption'],
      ['~Add down payment', 'act:deposit']
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
      ['@present_to_all^1', 'act:present']
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
      ['@smartphone^1', 'pay-apps'],
      ['Consumer financing^1', 'BACK'],
      ['@more_horiz^1', 'BACK']
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
      ['@north_west^1', 'cust-jobs'],
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
      // without this the extras screen is a dead end: no invoice, no sale
      ['Invoices^1', 'act:createInvoice']
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
      ['Invoice details^1', 'inv-details', 'modal'],
      ['Invoices^1', 'act:createInvoice']
    ],
    'inv-details': [
      ['Save', 'BACK']
    ],
    'ov-period': [
      ['~Last week', 'act:pickPeriod'],
      ['~Last month', 'act:pickPeriod'],
      ['~Last quarter', 'act:pickPeriod'],
      ['~Last year', 'act:pickPeriod'],
      ['~Last week', 'BACK'], ['~Last month', 'BACK'],
      ['~Last quarter', 'BACK'], ['~Last year', 'BACK'],
      ['~Custom week', 'act:pickWeek'],
      ['~Custom month', 'act:pickMonth'],
      ['~Custom quarter', 'act:pickQuarter'],
      ['~Custom year', 'act:pickYear'],
      ['~This week', 'act:pickPeriod'],
      ['~This month', 'act:pickPeriod'],
      ['~This quarter', 'act:pickPeriod'],
      ['~This year', 'act:pickPeriod']
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
      ['@photo_library^1', 'act:pickGallery'],
      ['@photo_camera^1', 'act:useCamera'],
      ['Cancel', 'BACK']
    ],
    'image-desc': [
      ['Save', 'act:mediaSaved']
    ]
  };

  /* apply link tables */
  /* The item catalog hid "add a custom item" behind the kebab in its
     header. Three dots are not an invitation — nobody opens them on the
     off chance, so a technician holding a part that isn't on the shelf
     had no way of knowing the app could take it.

     The other catalog already solves this: the design draws a dashed
     "Add custom item" card at the top of its list. The same card, in the
     same place, so both catalogs behave alike. */
  (function () {
    var src = byId('add-catalog'), dst = byId('est-catalog');
    if (!src || !dst) return;
    var card = $$('div', src).filter(function (e) {
      return /border:1px dashed/.test(e.getAttribute('style') || '') &&
        norm(e.textContent).indexOf('Add custom item') > -1;
    })[0];
    var pill = sel(dst, '@add^1')[0];
    var list = pill && pill.parentElement.parentElement.parentElement.parentElement;
    if (!card || !list) { MISS.push('est-catalog :: custom item'); return; }
    list.insertBefore(card.cloneNode(true), list.firstElementChild);

    // the kebab was this screen's only way to a custom item, and the reason
    // nobody found one. The card says it now, so the dots have nothing left
    // to offer — the other catalog never had them.
    var kebab = sel(dst, '@more_vert')[0];
    if (kebab) kebab.remove();
  })();

  /* =========================================================
     Notes is a tab, so it gets a tab's screen.

     It used to be a bottom sheet hung off the Notes tab, which made it
     behave unlike the other four: it covered the screen you came from,
     the strip underneath still showed that screen as current, and
     dismissing it dropped you back somewhere you had not chosen. The
     sheet's own parts are fine — a segment, a list, an Add note. They
     move onto a screen that carries the job's header and strip, the
     same ones every other tab draws.
     ========================================================= */
  (function () {
    var sheet = byId('ov-notes'), tpl = byId('job-general');
    if (!sheet || !tpl || !tpl.children[1]) { MISS.push('job-notes :: source'); return; }
    var panel = sheet.lastElementChild;            // the sheet body, under the scrim
    var parts = $$(':scope > div', panel);
    // grabber, title row, then the three pieces worth keeping
    var keep = parts.slice(2);
    if (keep.length < 3) { MISS.push('job-notes :: sheet parts'); return; }

    var scr = document.createElement('div');
    scr.className = 'screen';
    scr.id = 'job-notes';
    scr.setAttribute('data-tabs', 'on');
    scr.appendChild(tpl.children[0].cloneNode(true));       // Job header + Start
    var strip = tpl.children[1].cloneNode(true);            // the five tabs
    scr.appendChild(strip);
    keep.forEach(function (el) { scr.appendChild(el); });

    // the strip is cloned from General, so the underline has to move
    var on = $$(':scope > div', strip).filter(function (e) {
      return /border-bottom/.test(e.getAttribute('style') || '');
    })[0];
    var off = $$(':scope > div', strip).filter(function (e) { return e !== on; })[0];
    if (on && off) {
      var ACTIVE = on.getAttribute('style'), IDLE = off.getAttribute('style');
      on.setAttribute('style', IDLE);
      strip.children[1].setAttribute('style', ACTIVE);
    }

    // that 26px was the sheet clearing the home indicator; the tab bar is
    // below this screen instead
    var foot = scr.lastElementChild;
    foot.setAttribute('style', (foot.getAttribute('style') || '').replace('26px', '16px'));

    viewport.appendChild(scr);
    INFO['job-notes'] = {
      id: 'job-notes', title: 'Notes', section: 'job',
      desc: 'Every note on the job, in the tab that says Notes.',
      tabs: true, sb: false, overlay: false
    };
    sheet.remove();                                 // nothing routes to the sheet any more
  })();

  /* =========================================================
     One card for the job, not two.

     The board drew the job twice — once on Home, once on the in-progress
     screen — and the second copy was not the same card. Four chips instead
     of six, with the technician's notes and the job history missing, which
     are the two a tech reaches for once they are through the door. Address
     and phone in rows of their own. Different buttons. So pressing Start
     rearranged the thing you were reading.

     There is one card now, and it is the one from Home. It moves to the
     in-progress screen while a job runs and comes back afterwards, the way
     the dashboard already does. Being the same nodes, it cannot drift out
     of step with itself again.

     The second copy goes here, before the links are wired, so nothing is
     ever bound to it.
     ========================================================= */
  var activeCardSlot = null;
  (function () {
    var dst = byId('home-active'); if (!dst) return;
    var b = sel(dst, 'Randy Johnson')[0];
    var old = b && b.closest('div[style*="border-radius:14px"]');
    if (!old) { MISS.push('home-active :: job card'); return; }
    activeCardSlot = document.createComment('job card');
    old.parentElement.replaceChild(activeCardSlot, old);
  })();

  Object.keys(LINKS).forEach(function (id) {
    link(id, LINKS[id].filter(function (s) { return s[1] !== null && s[1] !== undefined; }));
    // explicit "inert" entries: mark as tappable but do nothing
    LINKS[id].filter(function (s) { return s[1] === null; }).forEach(function (s) {
      sel(byId(id) || document.createElement('div'), s[0]).forEach(function (e) { e.dataset.tap = '1'; });
    });
  });


  /* =========================================================
     Job actions belonged to the job, not to the customer.

     En route, Equipment, Assets and Set to "Completed" were hung off the
     "Additional information" row inside the Customer card — a disclosure
     that names what it does and then did something else. Nothing on that
     row suggests it ends a job.

     They move to a kebab in the job's own header, reachable from every
     tab and sitting next to Start, where an app's actions live. And the
     row goes back to disclosing what it says it discloses.
     ========================================================= */
  (function () {
    var done = [];
    $$('.screen [data-act="start"]').forEach(function (btn) {
      var scr = btn.closest('.screen');
      var hdr = btn.parentElement;
      // only a job header — on Home the same button sits inside a card
      if (!scr || !hdr || hdr !== scr.children[0]) return;
      jobHeaderBtns.push(btn);
      if (done.indexOf(hdr) > -1) return;
      done.push(hdr);
      var kebab = document.createElement('span');
      kebab.className = 'mi';
      kebab.setAttribute('style', 'font-size:23px;color:#4A6FA5');
      kebab.textContent = 'more_vert';
      kebab.dataset.tap = '1';
      kebab.dataset.go = 'ov-job-actions';
      hdr.appendChild(kebab);
    });
    if (!done.length) MISS.push('job :: actions kebab');
  })();

  /* The only way into a customer's past jobs was a grey chip reading
     "12 Jobs" beside their name. It looks like a statistic, because that
     is what a chip is for, and a technician standing at the door wanting
     to know what we did here last time has nothing that says so. It gets
     a row that says it, with the count and an arrow. */
  (function () {
    var root = byId('job-general'); if (!root) return;
    var chip = sel(root, '12 Jobs')[0];
    var nameRow = chip && chip.parentElement;
    var card = nameRow && nameRow.parentElement;
    if (!chip || !card) { MISS.push('job-general :: job history'); return; }
    var n = parseInt(norm(chip.textContent), 10) || 0;

    var row = document.createElement('div');
    row.dataset.tap = '1';
    row.dataset.go = 'cust-jobs';
    row.setAttribute('style', 'display:flex;align-items:center;gap:11px;margin-top:12px;' +
      'padding-top:11px;border-top:1px solid #EDF0F5');
    row.innerHTML =
      '<span class="mi" style="font-size:20px;color:#4A6FA5;flex:none">history</span>' +
      '<span style="flex:1;font:500 14px/1.35 Geist;color:#4A6FA5">Job history' +
      '<span style="display:block;font:400 12.5px/1.35 Geist;color:#8A97A8;margin-top:3px"></span></span>' +
      '<span class="mi" style="font-size:20px;color:#A9B4C2;flex:none">chevron_right</span>';
    $('span span', row).textContent = n
      ? 'What we have done at this address before · ' + n + ' jobs'
      : 'What we have done at this address before';

    // above the disclosure, so the card reads: who they are, what we did, the rest
    card.insertBefore(row, nameRow.nextElementSibling);
  })();

  /* Every past job carried a blue chip reading "7 items" in its corner.
     "Items" means something exact in this app now — the lines that make up
     what a job is worth — and these are not those: they are the photos and
     files left on the visit. A paperclip and a number, which is what the
     number has always been. */
  (function () {
    var root = byId('cust-jobs'); if (!root) return;
    var chips = $$('span', root).filter(function (e) {
      return /^[0-9]+ items$/.test(norm(e.textContent));
    });
    if (!chips.length) { MISS.push('cust-jobs :: attachment counts'); return; }
    chips.forEach(function (chip) {
      var n = norm(chip.textContent).split(' ')[0];
      chip.setAttribute('style', 'display:flex;align-items:center;gap:5px;' +
        'font:600 12.5px/1 Geist;color:#546478;white-space:nowrap');
      chip.innerHTML = '<span class="mi" style="font-size:16px;color:#8A97A8">attach_file</span><span></span>';
      chip.lastElementChild.textContent = n;
      chip.title = n + ' photos and files on this job';
    });
  })();

  /* Every job in the customer's history wore the same chip — "Estimate",
     or "No estimate" on the one that billed nothing. That is not what the
     chip says. It is the type of visit, and the types are Estimate,
     Install, Maintenance and Demand Service. Whether an estimate exists is
     a different question, and the money at the foot of the row answers it
     already.

     Four visits to one address, each a different kind of call, which is
     what a history is for: the tune-up in June explains the install in
     December. The June row was also dimmed for billing nothing — a
     maintenance visit under agreement bills nothing and still happened. */
  var PAST_VISITS = [
    ['Install', 'System replacement'],
    ['Demand Service', 'AC not cooling'],
    ['Maintenance', 'Seasonal tune-up'],
    ['Estimate', 'Ductwork and air handler']
  ];
  (function () {
    var root = byId('cust-jobs'); if (!root) return;
    var list = $('.sc', root);
    var rows = list ? $$(':scope > div', list) : [];
    if (rows.length !== PAST_VISITS.length) { MISS.push('cust-jobs :: visit rows'); return; }
    var CHIP = 'font:600 11.5px/1 Geist;color:#4A6FA5;background:#EBF0F8;' +
      'border:1px solid #C8D5E8;border-radius:5px;padding:3px 6px;white-space:nowrap';
    rows.forEach(function (row, i) {
      var line = row.children[1];
      var brief = line && line.children[0], chip = line && line.children[1];
      if (!brief || !chip) { MISS.push('cust-jobs :: visit ' + i); return; }
      brief.textContent = PAST_VISITS[i][1];
      chip.textContent = PAST_VISITS[i][0];
      chip.setAttribute('style', CHIP);
      row.style.opacity = '';
    });
  })();

  /* The row said "Additional information · 2" and opened a menu. It now
     discloses the two the customer actually has — the address for sending
     paperwork, and what the technician needs to get through the gate. */
  (function () {
    var root = byId('job-general'); if (!root) return;
    var label = sel(root, 'Additional information')[0];
    var head = label && label.parentElement;
    var card = head && head.parentElement;
    var chev = head && $('.mi', head);
    if (!label || !card || !chev) { MISS.push('job-general :: additional information'); return; }

    var box = document.createElement('div');
    box.hidden = true;
    box.setAttribute('style', 'margin-top:11px;padding-top:11px;border-top:1px solid #EDF0F5;' +
      'display:flex;flex-direction:column;gap:12px');
    [
      ['Email', 'randy.johnson@gmail.com'],
      ['Access notes', 'Gate code 4417 · dog in the back yard']
    ].forEach(function (r) {
      var row = document.createElement('div');
      row.innerHTML = '<div style="font:400 12px/1 Geist;color:#8A97A8"></div>' +
        '<div style="font:500 14px/1.4 Geist;margin-top:5px;text-wrap:pretty"></div>';
      row.children[0].textContent = r[0];
      row.children[1].textContent = r[1];
      box.appendChild(row);
    });
    card.appendChild(box);

    head.dataset.tap = '1';
    head.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = box.hidden;
      box.hidden = !open;
      chev.textContent = open ? 'expand_less' : 'expand_more';
    }, true);
  })();

  /* The service agreement tier is a billing fact, not something the
     technician acts on at the door. It was the card's last row, so the
     one above it has to give up its divider or the card ends on a line
     with nothing under it. */
  (function () {
    var root = byId('job-general'); if (!root) return;
    var label = sel(root, 'Service agreement')[0];
    var row = label && label.parentElement;
    if (!row) { MISS.push('job-general :: service agreement'); return; }
    var prev = row.previousElementSibling;
    if (prev) {
      prev.setAttribute('style',
        (prev.getAttribute('style') || '').replace(/;?border-bottom:[^;]*/, ''));
    }
    row.remove();
  })();

  /* =========================================================
     The photo viewer, the way the board draws it: Media.

     It came out of the export half-dark — the frame carried the black
     background, which is the one thing the export does not bring across,
     so a white-on-dark header landed on the app's light ground and went
     invisible. Painting the screen black fixed the header and left a
     lightbox in the middle of a light app.

     It is light now, and laid out the way the board lays it out: a title,
     a row of tools, the photo, what the photo is and says, and the page
     it is on. The tools were two dead icons in the header — share did
     nothing at all; they are four that work, and the one that opens the
     description is among them, so the button that used to say so is gone.
     ========================================================= */
  var photoType = recall('photoType', 'After');
  var paintPhotoType = function () { };
  (function () {
    var v = byId('photo-detail'); if (!v) { MISS.push('photo-detail :: screen'); return; }
    var head = v.children[0], img = v.children[1], pager = v.children[2], sheet = v.children[3];
    if (!head || !img || !pager || !sheet) { MISS.push('photo-detail :: parts'); return; }

    v.style.background = '#F2F5F9';
    v.dataset.tabs = 'on';
    if (INFO['photo-detail']) INFO['photo-detail'].tabs = true;

    head.setAttribute('style', 'display:flex;align-items:center;gap:12px;padding:13px 16px;' +
      'flex:none;background:#fff;border-bottom:1px solid #DDE3EE;color:#1A2332');
    head.children[0].textContent = 'arrow_back';
    head.children[1].textContent = 'Media';

    var del = byIcon(head, 'delete_outline')[0];
    var share = byIcon(head, 'ios_share')[0];
    if (share) share.remove();

    var bar = document.createElement('div');
    bar.setAttribute('style', 'display:flex;align-items:center;gap:32px;padding:13px 20px;' +
      'flex:none;background:#fff;border-bottom:1px solid #EDF0F5');
    function tool(icon, act) {
      var e = document.createElement('span');
      e.className = 'mi';
      e.dataset.tap = '1';
      e.dataset.act = act;
      e.setAttribute('style', 'font-size:23px;color:#1A2332');
      e.textContent = icon;
      return e;
    }
    bar.appendChild(tool('chat', 'mediaDescribe'));
    bar.appendChild(tool('gesture', 'mediaMarkup'));
    bar.appendChild(tool('download', 'mediaDownload'));
    if (del) {
      del.setAttribute('style', 'font-size:23px;color:#1A2332');
      bar.appendChild(del);
    }
    v.insertBefore(bar, img);

    img.setAttribute('style', 'flex:1;display:flex;align-items:center;justify-content:center;' +
      'background:#E4E9F1');
    var ph = $('.mi,.mif', img);
    if (ph) ph.setAttribute('style', 'font-size:64px;color:#A9B4C2');

    var row = sheet.children[0];
    var desc = sheet.children[1];
    var btn = sheet.children[2];
    var badge = row && row.children[0];
    var meta = row && row.children[1];
    if (!badge || !meta || !desc) { MISS.push('photo-detail :: caption'); return; }

    sheet.setAttribute('style', 'flex:none;background:#F2F5F9;padding:12px 16px 2px');
    row.setAttribute('style', 'display:flex;align-items:center;gap:9px;flex-wrap:wrap');
    desc.setAttribute('style', 'font:400 14.5px/1.45 Geist;color:#1A2332');
    sheet.appendChild(meta);                 // out of the badge row, onto its own line
    row.appendChild(desc);                   // beside the badge, as the board has it
    meta.setAttribute('style', 'font:500 12px/1 Geist;color:#8A97A8;margin-top:7px');
    if (btn) btn.remove();                   // the first tool opens the description now

    var TYPE_COLOUR = { After: '#16A34A', Before: '#4A6FA5', Other: '#546478' };
    paintPhotoType = function () {
      badge.setAttribute('style', 'font:600 11.5px/1 Geist;color:#fff;border-radius:5px;' +
        'padding:5px 8px;flex:none;background:' + (TYPE_COLOUR[photoType] || '#546478'));
      badge.textContent = photoType;
      $$('[data-typeval]').forEach(function (e) { e.textContent = photoType; });
      $$('[data-imgtype]').forEach(function (r) {
        var on = r.dataset.imgtype === photoType;
        r.style.background = on ? '#F2F5F9' : '';
        $('.mi,.mif', r).style.visibility = on ? 'visible' : 'hidden';
      });
    };

    // the pager's chevrons were never wired to anything; the board shows the
    // page as a pill under the caption, and that is all it ever said
    var pill = document.createElement('div');
    pill.setAttribute('style', 'display:flex;justify-content:center;padding:12px 0 16px;flex:none');
    pill.innerHTML = '<span data-mediapage style="background:#fff;border:1px solid #DDE3EE;' +
      'border-radius:14px;padding:7px 15px;font:600 12.5px/1 Geist;color:#1A2332;' +
      'font-variant-numeric:tabular-nums"></span>';
    pager.remove();
    v.appendChild(pill);
    // photoCount is declared further down the file; var hoists the name
    // and not the value, so read the store rather than the variable
    $('[data-mediapage]', pill).textContent = '1/' + recall('photoCount', 24);
    paintPhotoType();
  })();

  (function () {
    var list = byId('planList'); if (!list) return;
    PLANS.forEach(function (p, i) {
      var row = document.createElement('div');
      row.dataset.tap = '1';
      row.dataset.plan = String(i);
      row.setAttribute('style', 'display:flex;align-items:center;gap:11px;padding:15px 18px;' +
        'border-top:1px solid #EDF0F5;font:500 15.5px/1.35 Geist');
      row.innerHTML = '<div style="flex:1"><div data-nm></div>' +
        '<div data-sub style="font:400 12.5px/1.3 Geist;color:#8A97A8;margin-top:3px"></div></div>' +
        '<span class="mi" data-tick style="font-size:20px;color:#C8D5E8">radio_button_unchecked</span>';
      $('[data-nm]', row).textContent = p.name;
      $('[data-sub]', row).textContent = p.months
        ? p.rate.toFixed(2) + '% over ' + p.months + ' months · APR ' + p.apr.toFixed(2) + '%'
        : 'The customer pays the total, no monthly';
      list.appendChild(row);
    });
    list.addEventListener('click', function (ev) {
      var row = ev.target.closest('[data-plan]'); if (!row) return;
      ev.stopPropagation();
      planIdx = +row.dataset.plan;
      paintPlanRows();
      paintPlanEverywhere();
      setTimeout(back, 200);
      toast(plan().months ? 'Plan: ' + plan().name : 'No financing — total only', 'account_balance');
    }, true);
    paintPlanRows();
  })();

  function paintPlanRows() {
    var list = byId('planList'); if (!list) return;
    $$('[data-plan]', list).forEach(function (r) {
      var on = +r.dataset.plan === planIdx;
      var t = $('[data-tick]', r);
      t.textContent = on ? 'radio_button_checked' : 'radio_button_unchecked';
      t.className = (on ? 'mif' : 'mi');
      t.style.color = on ? '#4A6FA5' : '#C8D5E8';
      r.style.background = on ? '#EBF0F8' : '';
    });
  }

  /* The deposit is a sum of money, so it is typed as one. Round amounts
     sit alongside for the common cases — nobody wants a number pad open
     to say "five hundred". */
  var DEPOSIT_QUICK = [0, 250, 500, 1000];
  ACT.deposit = function () {
    var row = planRefs && planRefs.down; if (!row) return;
    var host = row.parentElement;
    if ($('[data-depositpick]', host)) return;

    var pick = document.createElement('div');
    pick.setAttribute('data-depositpick', '1');
    pick.setAttribute('style', 'margin-top:9px');
    pick.innerHTML =
      '<div style="display:flex;align-items:center;gap:9px;height:52px;padding:0 13px;' +
      'background:#fff;border:1.5px solid #4A6FA5;border-radius:10px">' +
      '<span style="font:600 17px/1 Geist;color:#8A97A8">$</span>' +
      '<input data-depinput class="inp" inputmode="decimal" placeholder="0.00" ' +
      'style="flex:1;height:auto;border:0;padding:0;background:transparent;font:600 17px/1 Geist">' +
      '</div>' +
      '<div data-depchips style="display:flex;gap:7px;margin-top:8px"></div>' +
      '<div data-dephint style="font:400 12px/1.4 Geist;color:#8A97A8;margin-top:8px"></div>';

    var chips = $('[data-depchips]', pick);
    DEPOSIT_QUICK.forEach(function (v) {
      var c = document.createElement('span');
      c.dataset.tap = '1';
      c.dataset.dep = String(v);
      c.textContent = v ? '$' + v.toLocaleString('en-US') : 'None';
      chips.appendChild(c);
    });
    host.insertBefore(pick, row.nextElementSibling);

    var input = $('[data-depinput]', pick);
    var hint = $('[data-dephint]', pick);
    input.value = deposit ? deposit.toFixed(2) : '';

    function paint() {
      $$('[data-dep]', chips).forEach(function (c) {
        var on = +c.dataset.dep === deposit;
        c.setAttribute('style', 'flex:1;text-align:center;border-radius:9px;padding:12px 0;' +
          'font:600 13.5px/1 Geist;' + (on
            ? 'background:#4A6FA5;color:#fff'
            : 'background:#fff;border:1px solid #C8D5E8;color:#4A6FA5'));
      });
      // a deposit bigger than an option pays that option off outright
      var lowest = Math.min.apply(null, Object.keys(OPTION_TOTALS)
        .slice(0, optCount).map(function (k) { return OPTION_TOTALS[k]; }).concat([Infinity]));
      hint.textContent = !deposit ? 'Taken off the price before the monthly is worked out.'
        : deposit >= lowest ? 'Covers the cheaper options outright — nothing left to finance on those.'
          : fmt(deposit) + ' down, the rest financed.';
    }
    paint();
    paintPlanEverywhere();

    input.addEventListener('input', function () {
      deposit = Math.max(0, parseFloat(String(input.value).replace(/[^0-9.]/g, '')) || 0);
      paint();
      paintPlanEverywhere();
    });
    chips.addEventListener('click', function (ev) {
      var c = ev.target.closest('[data-dep]'); if (!c) return;
      ev.stopPropagation();
      deposit = +c.dataset.dep;
      input.value = deposit ? deposit.toFixed(2) : '';
      paint();
      paintPlanEverywhere();
    }, true);
  };

  /* job tab strips */
  ['job-general', 'job-notes', 'rc-overview', 'est-empty', 'est-draft', 'est-review',
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
    period = norm(el.textContent).replace(/^Apply · /, '');
    closeOverlays(false);
    popWhile(function (id) { return /^(period-quarter|period-week)$/.test(id); });
    paintPeriod();
    toast('Showing ' + period, 'event');
  };

  /* ‹ 2024 › was drawn on three pickers and wired on none, and the Apply
     button underneath kept whatever the mock-up had typed into it — so a
     technician could step to 2025, tap September, and apply May 2024.
     The year moves, and the button says what will actually be applied. */
  var pickState = {};
  function paintApply(id) {
    var p = pickState[id]; if (!p || !p.apply) return;
    p.apply.textContent = 'Apply · ' + p.label();
  }
  ['ov-period-month', 'period-quarter', 'period-week'].forEach(function (id) {
    var root = byId(id); if (!root) return;
    var apply = $$('div', root).filter(function (e) {
      return /^Apply · /.test(norm(e.textContent)) && !e.children.length;
    })[0];
    var yearEl = $$('span', root).filter(function (e) {
      return /^(19|20)[0-9][0-9]$/.test(norm(e.textContent)) &&
        /font:700 17px/.test(e.getAttribute('style') || '');
    })[0];
    pickState[id] = {
      apply: apply,
      year: function () { return yearEl ? norm(yearEl.textContent) : ''; },
      pick: null
    };
    if (!yearEl) return;
    var prev = byIcon(root, 'chevron_left')[0], next = byIcon(root, 'chevron_right')[0];
    if (!prev || !next) return;
    function step(by) {
      return function (ev) {
        ev.stopPropagation();
        yearEl.textContent = String((parseInt(norm(yearEl.textContent), 10) || 2024) + by);
        paintApply(id);
      };
    }
    prev.dataset.tap = '1'; next.dataset.tap = '1';
    prev.addEventListener('click', step(-1), true);
    next.addEventListener('click', step(1), true);
  });

  /* =========================================================
     The period the dashboard is showing.

     The sheet listed twelve ways to pick one and only four of them did
     anything: This week through This year moved a radio, Custom opened a
     picker that could not be applied, and Last anything did nothing at
     all. Nothing told you afterwards what you were looking at either —
     the heading said "Overview" whichever period was chosen.

     One period, named once, shown in the heading and reflected by the
     Week/Month/Quarter/Year control when it maps to one of them.
     ========================================================= */
  var period = 'This month';
  var periodRefs = null;
  var setHomeSeg = null;

  (function () {
    var root = byId('home'); if (!root) return;
    var title = sel(root, '~Overview')[0];
    if (!title) { MISS.push('home :: overview title'); return; }
    var qualifier = document.createElement('span');
    qualifier.setAttribute('style', 'font:400 15px/1.2 Geist;color:#8A97A8;margin-left:6px');
    // before the collapse chevron the other block appended
    title.insertBefore(qualifier, $('.mi', title));
    periodRefs = { qualifier: qualifier };
  })();

  function paintPeriod() {
    if (periodRefs && periodRefs.qualifier) periodRefs.qualifier.textContent = '(' + period + ')';
    // the segment only speaks in four words; a custom range is none of them
    var m = /^This (week|month|quarter|year)$/.exec(period);
    if (m && setHomeSeg) setHomeSeg(['week', 'month', 'quarter', 'year'].indexOf(m[1]));
  }

  /* =========================================================
     Custom week, month, quarter and year are one screen.

     Each is a title, a year to step through where that means anything,
     and a list to pick from. Picking is the whole interaction — there is
     no Apply, because there is nothing left to confirm once a row has
     been tapped.
     ========================================================= */
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var QUARTERS = ['January – March', 'April – June', 'July – September', 'October – December'];
  var dpKind = 'month';
  var dpYear = new Date().getFullYear();

  function dpRows() {
    if (dpKind === 'month') return MONTHS;
    if (dpKind === 'quarter') return QUARTERS;
    if (dpKind === 'week') {
      var w = []; for (var i = 1; i <= 52; i++) w.push('Week ' + i); return w;
    }
    var y = [], now = new Date().getFullYear();
    for (var k = 0; k < 8; k++) y.push(String(now - k));
    return y;
  }
  function dpLabel(row) {
    if (dpKind === 'year') return row;
    if (dpKind === 'week') return row + ' · ' + dpYear;
    return row + ' ' + dpYear;
  }

  function paintPicker() {
    var list = byId('dpList'); if (!list) return;
    byId('dpTitle').textContent = 'Pick custom ' + dpKind;
    toggleDisplay(byId('dpYear'), dpKind !== 'year');
    byId('dpYearVal').textContent = String(dpYear);
    list.innerHTML = '';
    dpRows().forEach(function (row) {
      var on = period === dpLabel(row);
      var r = document.createElement('div');
      r.dataset.tap = '1';
      r.dataset.dprow = row;
      r.setAttribute('style', 'display:flex;align-items:center;gap:12px;padding:16px 18px;' +
        'font:' + (on ? '600' : '500') + ' 15.5px/1 Geist;border-bottom:1px solid #EDF0F5' +
        (on ? ';background:#F2F5F9' : ''));
      r.innerHTML = '<span class="mif" style="font-size:20px;color:#4A6FA5;width:22px' +
        (on ? '' : ';visibility:hidden') + '">check</span><span></span>';
      r.children[1].textContent = row;
      list.appendChild(r);
    });
  }

  function openPicker(kind) {
    dpKind = kind;
    paintPicker();
    // the sheet it came from is another overlay, and overlays stack in DOM
    // order rather than by when they opened — so it takes the menu's place
    closeOverlays(true);
    go('ov-datepick', 'overlay');
    var list = byId('dpList'); if (list) list.scrollTop = 0;
  }

  ACT.pickMonth = function () { openPicker('month'); };
  ACT.pickQuarter = function () { openPicker('quarter'); };
  ACT.pickYear = function () { openPicker('year'); };
  ACT.pickWeek = function () { openPicker('week'); };

  (function () {
    var list = byId('dpList'); if (!list) return;
    list.addEventListener('click', function (ev) {
      var r = ev.target.closest('[data-dprow]'); if (!r) return;
      ev.stopPropagation();
      period = dpLabel(r.dataset.dprow);
      closeOverlays(false);
      paintPeriod();
      toast('Showing ' + period, 'event');
    }, true);
    [['dpPrev', -1], ['dpNext', 1]].forEach(function (p) {
      var b = byId(p[0]); if (!b) return;
      b.dataset.tap = '1';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        dpYear += p[1];
        paintPicker();
      }, true);
    });
  })();

  ACT.pickPeriod = function (el) {
    period = norm(el.textContent);
    closeOverlays(false);
    paintPeriod();
    toast('Showing ' + period.toLowerCase(), 'event');
  };

  /* segmented controls */
  setHomeSeg = seg('home', ['Week', 'Month', 'Quarter', 'Year'], 1, function (i) {
    period = 'This ' + ['week', 'month', 'quarter', 'year'][i];
    paintPeriod();
  });
  seg('photos', ['All 24', 'Before 4', 'After 20'], 0);
  seg('job-notes', ['Detailed 2', "Technician's 2", 'Private 1'], 0, function (i) {
    tabNoteKind = NOTE_ORDER[i];
    paintNotes();
  });
  /* =========================================================
     The item catalog.

     Five category tabs that all showed the same six items, and a search
     box that was a drawing of a search box. Six items is also most of the
     reason: the board names sixteen, and the export brought the first
     screenful.

     The other ten are added from the board's own list, at the board's own
     prices and wording, each tab is given something to hold, and both the
     tabs and the search decide what the list shows.
     ========================================================= */
  var CATALOG_ROWS = [
    ['AC Tune-Up', 'Routine inspection and cleaning of air conditioning system', 129, 'Repairs'],
    ['Blower Motor Repair', 'Diagnose and repair blower motor malfunction', 350, 'Repairs'],
    ['Capacitor Replacement', 'Replace faulty run/start capacitor in AC system', 180, 'Repairs'],
    ['Condenser Coil Cleaning', 'Deep clean outdoor condenser coils for optimal performance', 250, 'Repairs'],
    ['Drain Pan Replacement', 'Replace rusted or leaking condensate drain pan', 260, 'Repairs'],
    ['Refrigerant Recharge', 'Refill refrigerant and check for leaks', 350, 'Repairs'],
    ['Air Handler Replacement', 'Replace indoor air handler unit including labor', 2800, 'Equipment'],
    ['HVAC System Installation', 'Install complete HVAC system in residential property', 8900, 'Equipment'],
    ['Mini-Split System Install', 'Install ductless mini-split system for room or zone', 4200, 'Equipment'],
    ['Thermostat Replacement', 'Replace existing thermostat with programmable or smart unit', 220, 'Equipment'],
    ['Duct Cleaning', 'Clean air ducts to improve air quality and efficiency', 450, 'Ductwork'],
    ['HVAC Zoning Setup', 'Install zoning dampers and controls for multi-zone climate', 3500, 'Ductwork'],
    ['HVAC Filter Replacement', 'Replace standard air filter', 40, 'IAQ'],
    ['Attic Insulation Top-Up', 'Add insulation to attic to improve efficiency', 1800, 'IAQ'],
    ['Thermostat Calibration', 'Adjust and calibrate thermostat for accurate temperature control', 90, 'Others'],
    ['Emergency HVAC Call', '24/7 emergency service visit fee', 150, 'Others']
  ];

  var catalogFilter = function () { };
  (function () {
    var root = byId('est-catalog'); if (!root) return;
    var sc = $$('.sc', root).pop();
    var rows = sc ? $$(':scope > div', sc) : [];
    // the first row is "Add custom item"; the rest are the board's six
    var tpl = rows[1];
    if (!sc || !tpl) { MISS.push('est-catalog :: rows'); return; }

    function parts(row) {
      var left = row.firstElementChild.children[0];
      var right = row.firstElementChild.children[1];
      return {
        name: left.children[0], desc: left.children[1],
        price: right.children[0], row: row
      };
    }
    var byName = {};
    rows.slice(1).forEach(function (r) { byName[norm(parts(r).name.textContent)] = r; });

    CATALOG_ROWS.forEach(function (spec) {
      var row = byName[spec[0]];
      if (!row) {
        row = tpl.cloneNode(true);
        // a clone of an added row would arrive already ticked
        row.setAttribute('style', 'background:#fff;border:1px solid #DDE3EE;border-radius:12px;padding:13px 14px');
        sc.appendChild(row);
        var p0 = parts(row);
        p0.name.textContent = spec[0];
        p0.desc.textContent = spec[1];
        p0.price.textContent = fmt(spec[2]);
      }
      row.dataset.cat = spec[3];
      row.dataset.name = spec[0];
    });

    var search = null;
    (function () {
      var label = $$('span', root).filter(function (e) {
        return norm(e.textContent) === 'Search for item';
      })[0];
      var box = label && label.parentElement;
      if (!box) { MISS.push('est-catalog :: search'); return; }
      var inp = document.createElement('input');
      inp.className = 'inp';
      inp.placeholder = 'Search for item';
      inp.setAttribute('style', 'flex:1;height:auto;padding:0;border:0;background:transparent;' +
        'font:500 15px/1 Geist');
      box.replaceChild(inp, label);
      inp.addEventListener('input', function () { catalogFilter(); });
      search = inp;
    })();

    var cat = 'Repairs';
    var empty = document.createElement('div');
    empty.setAttribute('style', 'padding:30px 16px;text-align:center;font:400 14px/1.5 Geist;color:#8A97A8');
    sc.appendChild(empty);

    catalogFilter = function () {
      var q = search ? norm(search.value).toLowerCase() : '';
      var shown = 0;
      $$(':scope > div[data-cat]', sc).forEach(function (r) {
        // a search looks through the whole catalog, not just the open tab
        var on = q ? r.dataset.name.toLowerCase().indexOf(q) > -1 : r.dataset.cat === cat;
        r.hidden = !on;
        if (on) shown++;
      });
      empty.hidden = shown > 0;
      empty.textContent = q ? 'Nothing matches “' + norm(search.value) + '”.' : 'Nothing in this category yet.';
    };

    seg('est-catalog', ['Repairs', 'Equipment', 'Ductwork', 'IAQ', 'Others'], 0, function (i, label) {
      cat = label;
      if (search) search.value = '';
      catalogFilter();
    });
    catalogFilter();
  })();
  seg('est-new-option', ['Monthly payment + Total', 'Total only', 'Monthly payment only'], 0);
  seg('est-option', ['−20%', '0%', '+20%'], 1);
  /* The radio the customer actually taps. Everything downstream used to
     assume Option C no matter what was ticked, so the KPI, the day's sold
     figure and the confirmation all recorded an option nobody chose. */
  var pickedOption = 'Option A';        // the design's own checked radio
  seg('est-customer', ['Option A^1', 'Option B^1', 'Option C^1'], 0, function (i, label) {
    pickedOption = label.split('^')[0];
  });
  /* =========================================================
     Jobs history.

     The board draws it as pills over cards, and almost none of it did
     anything: the period moved a highlight over a list that never changed,
     the dates were three days in a December that has since gone by, and
     "Job Details" was blue text that read like a link and was not one.

     The dates are the technician's own recent days now, so the periods have
     something true to say, and each card carries the one thing a closed job
     still needs — the customer who catches you at the fence.
     ========================================================= */
  var HIST_DAYS = { Today: 0, Week: 7, Month: 31, Quarter: 92, Year: 366, 'All time': 36500 };
  var HIST_AGO = [0, 4, 20];                    // today, this week, this month
  var histPeriod = recall('histPeriod', 'Month');
  var paintHistory = function () { };
  var histJob = '';

  (function () {
    var root = byId('history'); if (!root) return;
    var first = sel(root, 'Today')[0];
    var strip = first && first.parentElement;
    var list = $('.sc', root);
    if (!strip || !list) { MISS.push('history :: strip'); return; }

    var cards = $$(':scope > div', list);
    if (cards.length !== HIST_AGO.length) { MISS.push('history :: cards'); return; }

    var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function dayLabel(ago) {
      var d = new Date();
      d.setDate(d.getDate() - ago);
      return MONTH[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }

    // the board tints the type chips; the screen fills them
    var TYPE_FILL = {
      'Estimate': '#16A34A', 'Maintenance': '#D97706',
      'Demand Service': '#4A6FA5', 'Install': '#6D28D9'
    };
    var rows = [];

    cards.forEach(function (card, i) {
      var head = card.children[0];
      var name = head && head.children[0];
      var date = head && head.children[1];
      var typeRow = card.children[1];
      var badge = typeRow && typeRow.children[1];
      var foot = card.lastElementChild;
      var link = foot && foot.children[0];
      var price = foot && foot.children[1];
      if (!name || !date || !badge || !link || !price) { MISS.push('history :: card ' + i); return; }

      date.textContent = dayLabel(HIST_AGO[i]);

      var t = norm(badge.textContent);
      badge.setAttribute('style', 'font:600 11.5px/1 Geist;color:#fff;border-radius:5px;' +
        'padding:5px 8px;white-space:nowrap;background:' + (TYPE_FILL[t] || '#546478'));

      link.setAttribute('style', 'height:38px;padding:0 15px;display:flex;align-items:center;' +
        'background:#fff;border:1px solid #C8D5E8;color:#4A6FA5;border-radius:9px;' +
        'font:600 13.5px/1 Geist');
      link.dataset.tap = '1';
      link.dataset.go = 'job-general';

      var money = norm(price.textContent);
      // on a narrow phone the range used to break mid-number; the label gives
      // way first and the figure stays in one piece
      foot.setAttribute('style', 'display:flex;justify-content:space-between;align-items:center;' +
        'gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid #EDF0F5');
      link.style.flex = 'none';
      price.setAttribute('style', 'text-align:right;font:500 13px/1.35 Geist;color:#546478');
      price.innerHTML = '<span>Price range: </span>' +
        '<span data-money style="font:600 13.5px/1.35 Geist;color:#1A2332;white-space:nowrap"></span>';
      $('[data-money]', price).textContent = money;

      var who = norm(name.textContent);
      var kebab = document.createElement('span');
      kebab.className = 'mi';
      kebab.dataset.tap = '1';
      kebab.dataset.act = 'histMenu';
      kebab.dataset.job = who;
      kebab.setAttribute('style', 'font-size:21px;color:#8A97A8;margin-left:2px');
      kebab.textContent = 'more_vert';
      head.appendChild(kebab);

      rows.push({ el: card, ago: HIST_AGO[i], name: who });
    });

    /* The period was a segmented control over a list it could not change.
       Pills, the way the board draws them, and they pick what is shown. */
    var pills = $$(':scope > div', strip);
    strip.setAttribute('style', 'display:flex;align-items:center;gap:7px;margin:0 16px 12px;flex:none');
    var PILL_ON = 'flex:1;text-align:center;padding:10px 0;border-radius:18px;' +
      'font:600 13px/1 Geist;color:#fff;background:#4A6FA5';
    var PILL_OFF = 'flex:1;text-align:center;padding:10px 0;border-radius:18px;' +
      'font:500 13px/1 Geist;color:#546478;background:#fff;border:1px solid #DDE3EE';

    var more = document.createElement('div');
    more.dataset.tap = '1';
    more.dataset.go = 'ov-histperiod';
    more.dataset.mode = 'overlay';
    more.setAttribute('style', 'flex:none;width:38px;height:38px;display:flex;align-items:center;' +
      'justify-content:center;border-radius:19px;background:#fff;border:1px solid #DDE3EE;color:#546478');
    more.innerHTML = '<span class="mi" style="font-size:20px">more_vert</span>';
    strip.appendChild(more);

    var empty = document.createElement('div');
    empty.setAttribute('style', 'padding:34px 20px;text-align:center;font:400 14px/1.5 Geist;color:#8A97A8');
    empty.textContent = 'Nothing closed in this period.';
    list.appendChild(empty);

    paintHistory = function () {
      var named = false;
      pills.forEach(function (p) {
        var on = norm(p.textContent) === histPeriod;
        if (on) named = true;
        p.setAttribute('style', on ? PILL_ON : PILL_OFF);
      });
      var cut = HIST_DAYS[histPeriod];
      if (cut === undefined) cut = 31;
      var shown = 0;
      rows.forEach(function (c) {
        c.el.hidden = c.ago > cut;
        if (!c.el.hidden) shown++;
      });
      empty.hidden = shown > 0;
      // a period the pills cannot name still has to look chosen
      more.style.background = named ? '#fff' : '#EBF0F8';
      more.style.borderColor = named ? '#DDE3EE' : '#C8D5E8';
      $$('[data-histperiod]').forEach(function (r) {
        var on = r.dataset.histperiod === histPeriod;
        r.style.background = on ? '#F2F5F9' : '';
        $('.mi,.mif', r).style.visibility = on ? 'visible' : 'hidden';
      });
    };

    strip.addEventListener('click', function (ev) {
      var p = ev.target.closest('div');
      if (!p || pills.indexOf(p) < 0) return;
      ev.stopPropagation();
      histPeriod = norm(p.textContent);
      remember('histPeriod', histPeriod);
      paintHistory();
    }, true);
  })();

  /* the periods that do not fit on the strip */
  (function () {
    var list = byId('histPeriodList'); if (!list) return;
    ['Today', 'Week', 'Month', 'Quarter', 'Year', 'All time'].forEach(function (p) {
      var r = document.createElement('div');
      r.dataset.tap = '1';
      r.dataset.histperiod = p;
      r.setAttribute('style', 'display:flex;align-items:center;gap:12px;padding:16px 18px;' +
        'font:500 15.5px/1 Geist;border-bottom:1px solid #EDF0F5');
      r.innerHTML = '<span class="mif" style="font-size:20px;color:#4A6FA5;width:22px">check</span>' +
        '<span></span>';
      r.children[1].textContent = p;
      list.appendChild(r);
    });
    list.addEventListener('click', function (ev) {
      var r = ev.target.closest('[data-histperiod]'); if (!r) return;
      ev.stopPropagation();
      histPeriod = r.dataset.histperiod;
      remember('histPeriod', histPeriod);
      closeOverlays(false);
      paintHistory();
    }, true);
  })();
  paintHistory();
  seg('pay-apps', ['Zelle', 'Venmo', 'Cash App', 'Bank'], 0);
  /* =========================================================
     The money on the payment screens is the job's money.

     They carried the board's own little story — total $3,000, a $1,000
     down payment, $2,000 to collect — while the job in front of the
     technician was worth something else entirely. Two different amounts
     for the same visit, one screen apart, and the one the technician
     reads out to the customer was the wrong one.
     ========================================================= */
  var PAY_SCREENS = ['pay-card', 'pay-cash', 'pay-check', 'pay-apps'];
  var payAmount = 0;
  var cashTenders = [];
  var paintTenders = function () { };

  function valueFor(root, label) {
    var l = sel(root, label)[0];
    return l && l.nextElementSibling;
  }
  // the technician is handed notes, not coins — round up to something real
  function tendersFor(due) {
    var up = function (step) { return Math.ceil(due / step) * step; };
    var list = [due, up(50), up(100), up(500)];
    var seen = [], out = [];
    list.forEach(function (v) { if (v > 0 && seen.indexOf(v) < 0) { seen.push(v); out.push(v); } });
    return out.slice(0, 3);
  }

  function paintPayScreens() {
    var j = JOBS[jobIdx] || {};
    var jobTotal = j.sold ? j.sold.total : jobItemsTotal(j);
    // A deposit only counts once the customer has signed for the option it
    // was quoted against. On an estimate nobody bought, no money changed
    // hands, so there is nothing to take off the invoice.
    var paid = j.sold ? Math.min(deposit, jobTotal) : 0;
    payAmount = Math.max(0, jobTotal - paid);
    PAY_SCREENS.forEach(function (id) {
      var root = byId(id); if (!root) return;
      var total = valueFor(root, 'Total');
      var down = valueFor(root, 'Down payment') || valueFor(root, 'Deposit');
      var downLabel = sel(root, 'Down payment')[0];
      if (downLabel) downLabel.textContent = 'Deposit';
      var due = valueFor(root, 'To be paid');
      if (total) total.textContent = fmt(jobTotal);
      if (down) down.textContent = fmt(paid);
      if (due) due.textContent = fmt(payAmount);
    });
    paintTenders();
    paintCash(payAmount);
  }

  function paintCash(received) {
    var root = byId('pay-cash'); if (!root) return;
    var head = sel(root, 'Cash received')[0];
    var field = head && head.nextElementSibling;
    if (field) field.textContent = fmt(received);
    var change = valueFor(root, 'Change due');
    if (change) change.textContent = fmt(Math.max(0, received - payAmount));
  }

  (function () {
    var root = byId('pay-cash'); if (!root) return;
    cashTenders = tendersFor(2000);               // relabelled properly on every entry
    var chips = ['$2,000', '$2,500', '$3,000'];
    seg('pay-cash', chips, 0, function (i) { paintCash(cashTenders[i] || payAmount); });
    // keep the elements so the labels can follow the job's total
    var els = chips.map(function (c) { return sel(root, c)[0]; });
    paintTenders = function () {
      cashTenders = tendersFor(payAmount);
      els.forEach(function (e, i) {
        if (!e) return;
        var v = cashTenders[i];
        e.hidden = v === undefined;
        if (v !== undefined) e.textContent = '$' + v.toLocaleString('en-US');
      });
    };
  })();

  seg('ov-period', ['~This week', '~This month', '~This quarter', '~This year'], 1, function () { setTimeout(back, 240); });
  (function () {
    var p = pickState['ov-period-month']; if (!p) return;
    p.pick = 'May';
    p.label = function () { return p.pick + ' ' + p.year(); };
    seg('ov-period-month', ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'], 4, function (i, label) {
        p.pick = label;
        paintApply('ov-period-month');
      });
    paintApply('ov-period-month');
  })();
  (function () {
    var p = pickState['period-quarter']; if (!p) return;
    p.pick = 'Q2'; p.yearPick = '2024';
    p.label = function () { return p.pick + ' ' + p.yearPick; };
    seg('period-quarter', ['Q1^1', 'Q2^1', 'Q3^1', 'Q4^1'], 1, function (i, label) {
      p.pick = label.split('^')[0];
      paintApply('period-quarter');
    });
    // this screen carries its own list of years rather than a stepper
    seg('period-quarter', ['2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018'], 1,
      function (i, label) { p.yearPick = label; paintApply('period-quarter'); });
    paintApply('period-quarter');
  })();
  (function () {
    var p = pickState['period-week']; if (!p) return;
    p.pick = 'Week 13';
    p.label = function () { var y = p.year(); return p.pick + (y ? ' · ' + y : ''); };
    seg('period-week', ['Week 11^1', 'Week 12^1', 'Week 13^1', 'Week 14^1', 'Week 15^1', 'Week 16^1',
      'Week 17^1', 'Week 18^1', 'Week 19^1', 'Week 20^1', 'Week 21^1', 'Week 22^1'], 2,
      function (i, label) { p.pick = label.split('^')[0]; paintApply('period-week'); });
    paintApply('period-week');
  })();
  // every Good / Attention / Immediate row on every Report Card screen — the
  // System Analysis rows had never been wired; only their sub-tabs were
  ['rc-section', 'rc-furnace', 'rc-condenser', 'rc-refrigerant'].forEach(ratingRows);
  paintRcBadges();
  // Furnace / Condenser / Refrigerant were three screens carrying a copy of
  // the control each. One control now, swapping bodies inside the open section.
  var rcSysPick = function () { };
  seg('rc-furnace', ['Furnace', 'Condenser', 'Refrigerant'], 0, function (i) { rcSysPick(i); });

  /* checkbox / switch toggles */
  iconToggle('rc-customer', '@check_box_outline_blank', 'check_box_outline_blank', 'check_box', '#A9B4C2', '#4A6FA5');
  iconToggle('rc-refrigerant', '@check_box', 'check_box', 'check_box_outline_blank', '#16A34A', '#A9B4C2');
  /* =========================================================
     The history filter.

     A two-handled slider is a poor way to ask for money on a phone: the
     thumbs are 24px apart at the bottom of the range, where most jobs are,
     and a technician who knows they are looking for something over two
     thousand has to drag for it. Two fields take the answer directly, and
     the range above them says what was understood.

     The statuses were pills that looked like buttons; three of them, any
     number selectable, which is a checkbox.
     ========================================================= */
  var resetPrice = function () { };
  var resetChips = (function () {
    var root = byId('hist-filters'); if (!root) return function () { };
    var labels = ['Pending', 'Rejected', 'Accepted'];
    var boxes = labels.map(function (l) { return sel(root, '~' + l)[0] || sel(root, l)[0]; });
    if (boxes.some(function (b) { return !b; })) { MISS.push('hist-filters :: statuses'); return function () { }; }
    var wrap = boxes[0].parentElement;
    wrap.setAttribute('style', 'display:flex;flex-direction:column');
    var START = { Pending: true, Rejected: false, Accepted: true };
    function paint(b, on) {
      b.dataset.on = on ? '1' : '0';
      b.setAttribute('style', 'display:flex;align-items:center;gap:12px;padding:12px 2px;' +
        'font:500 15px/1 Geist;color:#1A2332');
      b.innerHTML = '<span class="mi" style="font-size:23px;color:' +
        (on ? '#4A6FA5' : '#A9B4C2') + '">' +
        (on ? 'check_box' : 'check_box_outline_blank') + '</span><span></span>';
      b.lastElementChild.textContent = b.dataset.label;
    }
    boxes.forEach(function (b) {
      b.dataset.label = norm(b.textContent).replace(/^check/, '');
      b.dataset.tap = '1';
      paint(b, START[b.dataset.label]);
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        paint(b, b.dataset.on !== '1');
      }, true);
    });
    return function () { boxes.forEach(function (b) { paint(b, START[b.dataset.label]); }); };
  })();

  (function () {
    var root = byId('hist-filters'); if (!root) return;
    var title = sel(root, 'Price range')[0];
    var head = title && title.parentElement;
    var card = head && head.parentElement;
    var value = head && head.children[1];
    if (!card || !value || card.children.length < 3) { MISS.push('hist-filters :: price'); return; }

    // the slider and the two numbers printed under it both go
    card.removeChild(card.children[2]);
    card.removeChild(card.children[1]);

    var MIN = 0, MAX = 30000;
    var row = document.createElement('div');
    row.setAttribute('style', 'display:flex;align-items:center;gap:10px');
    row.innerHTML =
      '<label style="flex:1;display:block;background:#EDF0F5;border-radius:10px 10px 0 0;' +
      'border-bottom:1.5px solid #8A97A8;padding:8px 12px 7px">' +
      '<span style="display:block;font:400 11.5px/1 Geist;color:#546478">From</span>' +
      '<input data-pmin class="inp" type="number" inputmode="numeric" min="0" ' +
      'style="height:26px;padding:0;border:0;background:transparent;font:600 16px/1.3 Geist"></label>' +
      '<span style="font:500 14px/1 Geist;color:#8A97A8">–</span>' +
      '<label style="flex:1;display:block;background:#EDF0F5;border-radius:10px 10px 0 0;' +
      'border-bottom:1.5px solid #8A97A8;padding:8px 12px 7px">' +
      '<span style="display:block;font:400 11.5px/1 Geist;color:#546478">To</span>' +
      '<input data-pmax class="inp" type="number" inputmode="numeric" min="0" ' +
      'style="height:26px;padding:0;border:0;background:transparent;font:600 16px/1.3 Geist"></label>';
    card.appendChild(row);

    var lo = $('[data-pmin]', row), hi = $('[data-pmax]', row);
    function money(n) { return '$' + Number(n).toLocaleString('en-US'); }
    function paint() {
      var a = lo.value === '' ? MIN : Math.max(MIN, +lo.value);
      var b = hi.value === '' ? MAX : Math.min(MAX, +hi.value);
      // a range that reads backwards is a typo, not a filter
      value.textContent = b < a ? 'To is below From' : money(a) + ' – ' + money(b);
      value.style.color = b < a ? '#DC2626' : '#4A6FA5';
    }
    [lo, hi].forEach(function (e) { e.addEventListener('input', paint); });
    resetPrice = function () { lo.value = '6000'; hi.value = '15000'; paint(); };
    resetPrice();
  })();

  /* the header says what Reset does, and leaves the way it came */
  (function () {
    var root = byId('hist-filters'); if (!root) return;
    var back = byIcon(root, 'close')[0];
    if (back) back.textContent = 'arrow_back';
    var reset = sel(root, 'Reset')[0];
    if (!reset) { MISS.push('hist-filters :: reset'); return; }
    reset.setAttribute('style', 'display:flex;align-items:center;gap:5px;font:600 14px/1 Geist;color:#4A6FA5');
    reset.innerHTML = '<span class="mi" style="font-size:18px">close</span>Reset filters';
  })();
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
    if (!isOn) ntgbWho = '';
  });
  (function () {
    var chips = $$('[data-ntgb]', byId('closeout'));
    if (chips.length < 2) return;
    var ON = chips[0].getAttribute('style'), OFF = chips[1].getAttribute('style');
    var ON_STYLE = 'font:600 13px/1 Geist;color:#fff;background:#4A6FA5;border-radius:18px;padding:10px 14px';
    clearNtgbChips = function () {
      chips.forEach(function (o) { o.setAttribute('style', OFF); });
    };
    chips.forEach(function (c) {
      c.dataset.tap = '1';
      c.addEventListener('click', function () {
        ntgbWho = norm(c.textContent);
        chips.forEach(function (o) { o.setAttribute('style', o === c ? ON_STYLE : OFF); });
      });
    });
  })();

  /* =========================================================
     The closeout, filled in from what the app already knows.

     It shipped with the mock-up's answers baked in: two thousand dollars
     in the amount box, "collected on site" already on, "presentation
     given" already on, and a department already chosen for the go-back.
     Every one of those is a claim about the visit, pre-answered, on a
     form whose whole point is that dispatch stops getting empty notes.
     A pre-answered form is worse than an empty one — nobody reads a
     field that is already filled.

     So the app fills in only what it can actually know: the amount from
     the job, the method from the payment that was taken, the two
     switches from whether those things happened, and "chose" from the
     option the customer signed. Anything it cannot know is left blank.
     ========================================================= */
  var PAY_LABEL = {
    'pay-card': 'Credit Card', 'pay-cash': 'Cash',
    'pay-check': 'Check', 'pay-apps': 'Zelle / Venmo / Cash App'
  };

  function forceSwitch(el, on) {
    if (!el) return;
    if (el.dataset.on === (on ? '1' : '0')) return;
    el.click();                 // through the wired handler, so state stays true
  }

  function soldSummary(j) {
    if (!j || !j.sold) return '';
    var names = (j.items || []).filter(function (it) { return it.from === 'estimate'; })
      .map(function (it) { return (it.qty > 1 ? it.qty + ' × ' : '') + it.name; });
    return j.sold.option + ' — ' + fmt(j.sold.total) +
      (names.length ? ' (' + names.join(', ') + ')' : '');
  }

  /* An install is sold when the signed option carries installation work —
     that is the crew's job, and they arrive with nothing but these notes. */
  function installSold(j) {
    if (!j) return false;
    if (j.type === 'Install' && j.sold) return true;
    return (j.items || []).some(function (it) {
      return it.from === 'estimate' && it.cat === 'Installation';
    });
  }

  function paintCloseout() {
    var root = byId('closeout'); if (!root) return;
    var j = JOBS[jobIdx] || {};

    var amount = byId('coAmount');
    var total = j.sold ? j.sold.total : jobItemsTotal(j);
    if (amount && !amount.dataset.touched) amount.value = total ? fmt(total) : '';

    var method = byId('coMethod');
    if (method && method.firstChild) {
      method.firstChild.nodeValue = payMethod || 'Not collected';
    }
    forceSwitch(byId('coCollected'), state.inv === 'paid');
    forceSwitch(byId('coPresented'), estPresented);

    // 3 · Chose — the option the customer put their name to
    var chose = $$('#closeout .co-f')[2];
    if (chose && !chose.value) chose.value = soldSummary(j);

    paintInstall();
  }

  function paintInstall() {
    var card = byId('coInstall'); if (!card) return;
    var need = installSold(JOBS[jobIdx]);
    card.hidden = !need;
    if (!need) return;
    var photos = byId('coPhotoState');
    if (photos) {
      photos.textContent = photosThisVisit
        ? photosThisVisit + ' ' + plural(photosThisVisit) + ' on this visit'
        : 'None taken on this visit';
    }
    var state_ = byId('coInstallState');
    var missing = installMissing();
    if (state_) {
      var ok = !missing.length;
      state_.textContent = ok ? 'Ready for the crew' : 'Incomplete';
      state_.setAttribute('style', 'font:600 11.5px/1 Geist;border-radius:5px;padding:5px 8px;' +
        (ok ? 'color:#15803D;background:#E8F6ED;border:1px solid #B6E3C6'
            : 'color:#B45309;background:#FEF3E2;border:1px solid #F3D9AE'));
    }
  }

  function installMissing() {
    if (!installSold(JOBS[jobIdx])) return [];
    var gaps = [];
    [['coScope', 'the scope'], ['coSite', 'site conditions'], ['coParts', 'the parts list']]
      .forEach(function (p) {
        var el = byId(p[0]);
        if (el && !el.value.trim()) gaps.push(p[1]);
      });
    if (!photosThisVisit) gaps.push('a photo');
    return gaps;
  }

  /* The department has to be named, or the go-back lands on nobody's desk. */
  var ntgbWho = '';
  var clearNtgbChips = function () { };

  /* The form's text is wiped when a job closes, but its switches were not,
     so the next job opened with the last one's answers still set — "need to
     go back" on, against a customer it was never about. */
  function resetNtgb() {
    ntgbWho = '';
    clearNtgbChips();
    forceSwitch(byId('ntgbSwitch'), false);
    var who = byId('ntgbWho');
    if (who) who.hidden = true;
  }

  function ntgbOn() {
    var sw = byId('ntgbSwitch');
    return !!sw && sw.dataset.on === '1';
  }

  /* The closeout is typed on site, often with the app going in and out of the
     pocket — every keystroke is kept. */
  (function () {
    var fields = $$('#closeout .co-f');
    var saved = recall('closeout', []);
    fields.forEach(function (f, i) {
      if (saved[i] !== undefined && saved[i] !== null) f.value = saved[i];
      f.addEventListener('input', function () {
        remember('closeout', fields.map(function (x) { return x.value; }));
      });
    });
  })();

  /* US-M13-2 — Reset puts the filter sheet back to its defaults */
  ACT.filtersReset = function () {
    if (resetChips) resetChips();
    if (resetSwitches) resetSwitches();
    resetPrice();
    toast('Filters reset', 'restart_alt');
  };

  /* =========================================================
     Items, and groups of items.

     Marek, Sep 10: a small item carries basic information and nothing
     more — what it is (type), where it belongs (category), what the
     customer pays, and what it costs us. The cost has to stay readable in
     parts, because compensation splits into labour and commission and
     workers' comp is priced off labour alone. A packaged item that says
     "cost $200" and stops there can never be taken apart again.

     There are no item groups: a job that needs labour, several materials,
     equipment and a permit fee gets them as separate lines, entered one
     by one. That keeps every cost readable on its own, which was the
     point of the split in the first place.
     ========================================================= */
  var ITEM_TYPE = {
    service: ['Service', '#4A6FA5', '#EBF0F8'],
    material: ['Material', '#B45309', '#FEF3E2'],
    equipment: ['Equipment', '#6D28D9', '#F0EAFB'],
    admin: ['Admin fee', '#546478', '#F1F4F9'],
    asset: ['Asset use', '#0E7490', '#E4F3F7']
  };
  var COMMISSION_RATE = 0.10;      // Marek's own worked example: 10% labour, 10% commission

  /* price is what the customer pays. `labor` is what the technician earns
     on it — theirs to see. `supply` is what we pay someone else, and it
     never appears on this device. */
  var ITEMS = {};
  var BY_NAME = {};
  [
    // the catalog's own singles, at the design's prices
    ['SV-2001', 'AC Tune-Up', 'service', 'Maintenance', 129, 45, 0],
    ['SV-2002', 'Blower Motor Repair', 'service', 'Repair', 350, 90, 60],
    ['SV-2003', 'Duct Cleaning', 'service', 'Maintenance', 450, 150, 0],
    ['SV-2004', 'Condenser Coil Cleaning', 'service', 'Maintenance', 250, 70, 0],
    ['SV-2005', 'Capacitor Replacement', 'service', 'Repair', 180, 40, 35],
    ['SV-2006', 'Thermostat Calibration', 'service', 'Diagnostic', 90, 35, 0],
    ['SV-2007', 'Diagnostic Call', 'service', 'Diagnostic', 89, 30, 0],
    ['EQ-2001', 'Air Handler Replacement', 'equipment', 'Installation', 2800, 260, 1680],
    ['MT-2001', 'Attic Insulation Top-Up', 'material', 'Installation', 1800, 180, 900],
    ['MT-2002', 'HVAC Filter Replacement', 'material', 'Maintenance', 40, 8, 14],
    // the parts a package is built from
    ['SV-3001', 'System installation labour', 'service', 'Installation', 1200, 300, 0],
    ['SV-3002', 'Compressor replacement labour', 'service', 'Repair', 500, 100, 0],
    ['SV-3003', 'Duct cleaning labour, 2 techs', 'service', 'Maintenance', 380, 160, 0],
    ['MT-3101', 'Condensing unit, 3-ton 16 SEER', 'material', 'Installation', 2100, 0, 1450],
    ['MT-3102', 'Line set, 3/8" × 25 ft', 'material', 'Installation', 180, 0, 96],
    ['MT-3103', 'Refrigerant R-410A, 8 lb', 'material', 'Installation', 240, 0, 120],
    ['MT-3104', 'Compressor, scroll 3-ton', 'material', 'Repair', 380, 0, 210],
    ['MT-3105', 'Refrigerant R-410A, 4 lb', 'material', 'Repair', 120, 0, 60],
    ['MT-3106', 'Register & vent sanitiser', 'material', 'Maintenance', 45, 0, 22],
    ['EQ-3201', 'Air handler, variable speed', 'equipment', 'Installation', 1450, 0, 980],
    ['AD-3301', 'County permit fee', 'admin', 'Installation', 175, 0, 175],
    ['AS-3401', 'Crane, 1 hour', 'asset', 'Installation', 320, 0, 210],
    ['AS-3402', 'Negative-air machine, 3 hours', 'asset', 'Maintenance', 135, 0, 60]
  ].forEach(function (r) {
    ITEMS[r[0]] = { sku: r[0], name: r[1], type: r[2], cat: r[3], price: r[4], labor: r[5], supply: r[6] };
    BY_NAME[r[1]] = ITEMS[r[0]];
  });

  /* A line on a job. Every item carries its own type and category, and its
     own two numbers — what the customer pays and what the technician earns
     on it. There are no groups: multiple items are entered one by one, which
     is what the product does. */
  function jobLine(sku, qty, from) {
    var it = ITEMS[sku];
    if (!it) return { sku: sku, name: sku, type: 'material', cat: '', price: 0, labor: 0, qty: qty || 1, from: from || 'manual' };
    return {
      sku: it.sku, name: it.name, type: it.type, cat: it.cat,
      price: it.price, labor: it.labor, qty: qty || 1, from: from || 'manual'
    };
  }

  function typeChip(type, small) {
    var t = ITEM_TYPE[type] || ITEM_TYPE.material;
    return '<span style="font:600 ' + (small ? '10' : '10.5') + 'px/1 Geist;color:' + t[1] +
      ';background:' + t[2] + ';border-radius:4px;padding:4px 6px;white-space:nowrap">' + t[0] + '</span>';
  }

  /* The one catalog serves two destinations: the option a technician is
     building, and the job itself. Which one is set by the button that
     opened it, not guessed from the screen underneath. */
  var catalogTarget = 'option';

  /* catalogs + steppers */
  var estCatalog = catalog('est-catalog');
  catalog('add-catalog');

  /* =========================================================
     Items ticked in the catalog land in the option being built, with a
     working qty and a summary that adds up. Done used to just navigate
     back and the option stayed empty.
     ========================================================= */
  var optionItems = recall('optionItems', []);       // a half-built option survives a reload
  var addedOptions = recall('addedOptions', []);     // options the tech added beyond A/B/C
  var optItemsBox = null, optEmptyState = null, optSummary = null, optSaveBtn = null;

  /* The design draws this Save greyed out — that's the empty-option state,
     not decoration. It stays off until the option has something in it. */
  var SAVE_OFF = 'height:42px;padding:0 20px;display:flex;align-items:center;' +
    'background:#EDF0F5;color:#A9B4C2;border-radius:9px;font:600 14.5px/1 Geist';
  var SAVE_ON = 'height:42px;padding:0 20px;display:flex;align-items:center;' +
    'background:#4A6FA5;color:#fff;border-radius:9px;font:600 14.5px/1 Geist';
  function paintOptionSave() {
    if (!optSaveBtn) return;
    var ready = optionItems.length > 0;
    optSaveBtn.setAttribute('style', ready ? SAVE_ON : SAVE_OFF);
    optSaveBtn.dataset.ready = ready ? '1' : '';
  }
  (function () {
    var root = byId('est-new-option'); if (!root) return;
    var heading = sel(root, 'Option items')[0];
    optItemsBox = heading && heading.parentElement;
    optEmptyState = heading && heading.nextElementSibling;
    /* "Add new items" was drawn inside the empty state, so the moment the
       first item landed the empty state was hidden and the way to add a
       second went with it. The button is not part of the empty state — it
       is how the list grows — so it sits outside it. */
    var addItems = optEmptyState && sel(optEmptyState, '@add^1')[0];
    if (addItems) optItemsBox.insertBefore(addItems, optEmptyState.nextSibling);
    else MISS.push('est-new-option :: add new items');
    optSummary = {
      count: valueNextTo(root, '# of items'),
      monthly: valueNextTo(root, 'Monthly payment'),
      total: valueNextTo(root, 'Total')
    };
    optSaveBtn = sel(root, 'Save')[0];
    if (!optItemsBox || !optEmptyState || !optSummary.count || !optSaveBtn) MISS.push('est-new-option :: items');
    renderOptionItems();          // shows whatever was in progress before the reload
  })();

  function valueNextTo(root, label) {
    var l = sel(root, label)[0];
    return l && l.nextElementSibling;
  }

  /* The technician discounts a job at the kitchen table, with the customer
     watching. "Adjust the price" opened a screen of its own that had to be
     come back from; it is one slider, so it is a slider, under the thumb
     that tapped it. */
  var optAdjust = 0;                       // percent, −20…+20
  function optionBase() {
    return optionItems.reduce(function (a, it) { return a + it.price * it.qty; }, 0);
  }
  // the app already has an optionTotal() that reads a card; this one is the
  // option being built, after whatever the slider did to it
  function optionAdjusted() {
    return Math.round(optionBase() * (1 + optAdjust / 100) * 100) / 100;
  }

  function paintOptionSummary() {
    var total = optionAdjusted();
    var n = optionItems.reduce(function (a, it) { return a + it.qty; }, 0);
    if (optSummary.count) optSummary.count.textContent = String(n);
    if (optSummary.monthly) optSummary.monthly.textContent = fmt(monthlyFor(total));
    if (optSummary.total) optSummary.total.textContent = fmt(total);
  }

  function paintAdjust() {
    var pct = byId('adjPct'), tot = byId('adjTotal'), was = byId('adjWas');
    var rng = byId('adjRange');
    if (!pct || !tot || !rng) return;
    rng.value = String(optAdjust);
    pct.textContent = (optAdjust > 0 ? '+' : '') + optAdjust + '%';
    pct.style.color = optAdjust < 0 ? '#DC2626' : optAdjust > 0 ? '#16A34A' : '#4A6FA5';
    tot.textContent = fmt(optionAdjusted());
    if (was) {
      was.hidden = !optAdjust;
      was.textContent = 'Was ' + fmt(optionBase());
    }
  }

  (function () {
    var rng = byId('adjRange'); if (!rng) return;
    rng.addEventListener('input', function () {
      optAdjust = parseInt(rng.value, 10) || 0;
      paintAdjust();
      paintOptionSummary();
    });
  })();

  ACT.adjustPrice = function () {
    if (!optionItems.length) { toast('Add an item before adjusting the price', 'info'); return; }
    paintAdjust();
    go('ov-adjust', 'overlay');
  };

  function renderOptionItems() {
    if (!optItemsBox) return;
    $$('[data-optitem]', optItemsBox).forEach(function (e) { e.remove(); });
    toggleDisplay(optEmptyState, !optionItems.length);

    optionItems.forEach(function (it, i) {
      var card = document.createElement('div');
      card.setAttribute('data-optitem', '1');
      card.setAttribute('style', 'background:#fff;border:1px solid #DDE3EE;border-radius:12px;padding:13px 14px;margin-bottom:9px');
      card.innerHTML =
        '<div style="font:600 15.5px/1.3 Geist"></div>' +
        (it.desc ? '<div style="font:400 13px/1.45 Geist;color:#546478;margin:4px 0 7px"></div>' : '') +
        (it.warranty ? '<div style="font:500 12px/1 Geist;color:#8A97A8"></div>' : '') +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid #EDF0F5">' +
        '<div style="display:flex;align-items:center;border:1px solid #DDE3EE;border-radius:9px;overflow:hidden">' +
        '<div data-minus style="width:42px;height:42px;display:flex;align-items:center;justify-content:center;color:#4A6FA5"><span class="mi" style="font-size:20px">remove</span></div>' +
        '<div data-qty style="width:38px;text-align:center;font:600 15px/1 Geist;border-left:1px solid #DDE3EE;border-right:1px solid #DDE3EE;line-height:42px"></div>' +
        '<div data-plus style="width:42px;height:42px;display:flex;align-items:center;justify-content:center;color:#4A6FA5"><span class="mi" style="font-size:20px">add</span></div>' +
        '</div><span data-line style="font:600 15.5px/1 Geist"></span></div>';

      var parts = card.children;
      parts[0].textContent = it.name;
      var k = 1;
      if (it.desc) parts[k++].textContent = it.desc;
      if (it.warranty) parts[k++].textContent = it.warranty;
      var qtyEl = $('[data-qty]', card), lineEl = $('[data-line]', card);
      function paintRow() { qtyEl.textContent = String(it.qty); lineEl.textContent = fmt(it.price * it.qty); }
      paintRow();
      [['[data-minus]', -1], ['[data-plus]', 1]].forEach(function (p) {
        var b = $(p[0], card);
        b.dataset.tap = '1';
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          it.qty = Math.max(1, it.qty + p[1]);
          paintRow();
          paintOptionSummary();
        }, true);
      });
      optItemsBox.insertBefore(card, optEmptyState);
    });
    paintOptionSummary();
    paintOptionSave();
    remember('optionItems', optionItems);
  }

  steppers('est-option', ['Adjusted total', 'Total']);
  steppers('add-items', ['Section total']);

  /* =========================================================
     One line about the connection — US-M02-3 / US-M06-4 / US-M14-2.
     Offline, uploading, sent. Never two bars stacked saying the same thing.
     ========================================================= */
  var net = { online: navigator.onLine !== false, queue: 0, syncing: false, sentFlash: false };
  var up = { phase: 'idle', text: '', pct: 0 };        // idle | uploading | done
  var netbar = byId('netbar'), netmsg = byId('netmsg'), netIcon = byId('netIcon'), netFill = byId('netFill');
  var netHide = null;

  function plural(n) { return n === 1 ? 'photo' : 'photos'; }

  function paintNet() {
    var cls = '', icon = '', text = '', show = true;
    if (!net.online) {
      var pend = [];
      if (upPending) pend.push(upPending + ' ' + plural(upPending));
      if (net.queue) pend.push(net.queue + (net.queue === 1 ? ' change' : ' changes'));
      icon = 'cloud_off';
      text = pend.length ? 'Offline · ' + pend.join(' and ') + ' will send when you’re back'
        : 'Offline — working from saved data';
    } else if (net.syncing) { cls = 'sync'; icon = 'cloud_sync'; text = 'Back online — sending…'; }
    else if (up.phase === 'uploading') { cls = 'up'; icon = 'cloud_upload'; text = up.text; }
    else if (up.phase === 'done') { cls = 'ok'; icon = 'cloud_done'; text = up.text; }
    else if (net.sentFlash) { cls = 'ok'; icon = 'cloud_done'; text = 'All sent'; }
    else show = false;
    netbar.className = 'netbar' + (show ? ' on' : '') + (cls ? ' ' + cls : '');
    netIcon.textContent = icon;
    netmsg.textContent = text;
    netFill.style.width = up.phase === 'uploading' ? up.pct + '%' : '0';
    paintCloseoutBlocker();
  }
  function flashThenHide(ms) {
    clearTimeout(netHide);
    netHide = setTimeout(function () { up.phase = 'idle'; net.sentFlash = false; paintNet(); }, ms);
  }

  /* Anything the tech saves while offline joins the queue instead of failing. */
  function queued(what) {
    if (net.online) return;
    net.queue++;
    paintNet();
    return what;
  }
  function goOffline() { net.online = false; net.syncing = false; paintNet(); }
  function goOnline() {
    net.online = true;
    if (!net.queue && !upPending) { paintNet(); return; }
    // US-M14-2: queued work goes up by itself — no manual "Generate Report"
    net.syncing = true; paintNet();
    setTimeout(function () {
      net.queue = 0; net.syncing = false;
      if (upPending) startUpload(upPending, upLastBound);
      else { net.sentFlash = true; paintNet(); flashThenHide(2200); }
    }, 1100);
  }
  /* Cash, check and app transfers are just recorded, so they work with no
     signal. A card has to reach the processor — letting it "succeed" offline
     tells the tech money was taken when it wasn't. */
  var cardBtn = null, cardNote = null, cardRow = null;
  (function () {
    cardBtn = sel(byId('pay-card'), '@lock^1')[0];
    cardRow = sel(byId('ov-pay-method'), 'Credit Card^1')[0];
    if (!cardBtn) { MISS.push('pay-card :: pay button'); return; }
    cardNote = document.createElement('div');
    cardNote.setAttribute('style',
      'display:flex;align-items:flex-start;gap:9px;background:#FEF3E2;border:1px solid #F3D9AE;' +
      'border-radius:11px;padding:12px 13px;margin-bottom:10px');
    cardNote.innerHTML = '<span class="mi" style="font-size:18px;color:#D97706;margin-top:1px">cloud_off</span>' +
      '<div style="font:400 12.5px/1.45 Geist;color:#7A5B12">No connection, so the card can&rsquo;t be charged. ' +
      'Take cash or a check now, or run the card once you have signal.</div>';
    cardNote.hidden = true;
    cardBtn.parentElement.insertBefore(cardNote, cardBtn);
  })();

  function paintCardAvailability() {
    var blocked = !net.online;
    if (cardNote) cardNote.hidden = !blocked;
    if (cardBtn) {
      cardBtn.style.opacity = blocked ? '.45' : '';
      cardBtn.dataset.blocked = blocked ? '1' : '';
    }
    if (cardRow) cardRow.style.opacity = blocked ? '.45' : '';
  }

  window.addEventListener('offline', function () { goOffline(); paintCardAvailability(); });
  window.addEventListener('online', function () { goOnline(); paintCardAvailability(); });
  if (!net.online) goOffline();
  paintCardAvailability();

  /* =========================================================
     US-M15-1 — drive and work are clocked apart. The timesheet already
     had a Drive bucket with nothing feeding it; the job statuses feed it
     now. What the app records here is what payroll pays on, so the tech
     has to be able to see it.
     ========================================================= */
  var jobTimerEl = sel(phone, '43:45')[0] || null;   // the bar left home-active
  var VISIT_BASE = 15;
  var WEEK = { regular: 32.5, overtime: 4.0, drive: 6.2 };   // Mon–Thu, already banked
  var clock = { drive: 0, work: 0, mode: 'off', since: 0, visits: 0, sold: 0, labor: 0, commission: 0 };
  // a running clock keeps running through a reload — `since` is a timestamp
  Object.assign(clock, recall('clock', {}));

  function clockFlush() {
    if (clock.mode === 'off' || !clock.since) return;
    var secs = (Date.now() - clock.since) / 1000;
    clock[clock.mode] += secs;
    clock.since = Date.now();
  }
  function setClock(mode) {
    clockFlush();
    clock.mode = mode;
    clock.since = mode === 'off' ? 0 : Date.now();
    paintClock();
    remember('clock', clock);
  }
  function hm(secs) {
    var h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60);
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }
  // m:ss until the hour, then h:mm:ss — the shape the design's own 43:45 reads
  function shortClock(secs) {
    var t = Math.floor(Math.max(0, secs));
    var m = String(Math.floor(t % 3600 / 60));
    var ss = String(t % 60).padStart(2, '0');
    return t >= 3600 ? Math.floor(t / 3600) + ':' + m.padStart(2, '0') + ':' + ss
      : Math.floor(t / 60) + ':' + ss;
  }

  function hhmmss(secs) {
    var h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = Math.floor(secs % 60);
    return [h, m, s].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }

  var MODE_LABEL = { drive: ['Driving', '#F59E0B'], work: ['On site', '#16A34A'], off: ['Off the clock', '#7E93B2'] };
  function paintClock() {
    var running = clock.mode === 'off' ? 0 : (Date.now() - clock.since) / 1000;
    var lbl = MODE_LABEL[clock.mode];
    var set = function (id, v) { var e = byId(id); if (e) e.textContent = v; };

    set('tsMode', lbl[0]);
    var dot = byId('tsDot'); if (dot) dot.style.background = lbl[1];
    set('tsClock', hhmmss(clock.mode === 'off' ? clock.drive + clock.work : running));
    set('tsSince', clock.mode === 'off'
      ? (clock.drive + clock.work ? 'Total on the clock today' : 'Not started')
      : 'Since ' + new Date(clock.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
      // JOBS is declared further down; a restored running clock paints before it exists
      (typeof JOBS !== 'undefined' && JOBS[jobIdx] ? ' · ' + JOBS[jobIdx].name : ''));

    var drive = clock.drive + (clock.mode === 'drive' ? running : 0);
    var work = clock.work + (clock.mode === 'work' ? running : 0);
    set('tsDrive', (WEEK.drive + drive / 3600).toFixed(1) + 'h');
    set('tsRegular', (WEEK.regular + work / 3600).toFixed(1) + 'h');
    set('tsToday', hm(drive + work));
    paintDriveTime(drive);
    set('tsVisits', clock.visits + ' · ' + fmt(clock.visits * VISIT_BASE) + ' base');
    set('tsSold', fmt(clock.sold));
    // labour earned on the work, commission earned on the sale — two numbers,
    // because workers' comp is rated on the first one alone
    set('tsLabor', fmt(clock.visits * VISIT_BASE + clock.labor));
    set('tsCommission', fmt(clock.commission));

    // the header timer on the in-progress screen is the same work clock
    if (jobTimerEl) {
      // minutes only, so an hour on site read 61:20 and a long one 37255:53
      jobTimerEl.textContent = shortClock(work);
    }
    // and so is the one on the card's own button
    $$('[data-jobtime]').forEach(function (e) { e.textContent = shortClock(work); });

  }

  /* The card used to carry its own Driving / On site / Stop control, and it
     moved the clock and nothing else — pressing Stop there left the job card
     still counting and the green bar still saying "On site".

     Syncing the two was the wrong fix. Every minute in this app belongs to a
     job: the drive out is En route, the break is the job's own pause. There
     was nothing a second set of buttons could say that the job card was not
     already saying, so they are gone and this reads the clock the job keeps. */
  setInterval(function () { if (clock.mode !== 'off') paintClock(); }, 1000);
  paintClock();

  /* =========================================================
     US-M06-4 — a photo upload is visible while it happens, says whether
     it landed, and offers a retry for the ones that didn't. The counts
     around the app move only once the upload actually succeeds, so a
     failure can't quietly inflate them.
     ========================================================= */
  var photoCount = recall('photoCount', 24);
  var photoTypeCount = recall('photoTypeCount', { Before: 4, After: 20 });
  var paintTypeCounts = function () { };
  var countRefs = [];
  (function () {
    ['home', 'home-active'].forEach(function (id) {
      var pill = sel(byId(id), '@photo_library^1')[0];
      if (!pill) return;
      var t = pill.childNodes[pill.childNodes.length - 1];
      if (t && t.nodeType === 3) countRefs.push(function (n) { t.nodeValue = n + ' Photos'; });
    });
    var ph = byId('photos');
    if (ph) {
      /* The header reads "Photos 24" as one span wrapping another, so there
         was no element whose text was exactly "Photos" to find and no
         sibling after it — the count was never wired, and the screen showed
         "Photos 24" over a chip reading "All 25". The number is the span
         inside the header that is only a number. */
      var head = $$('span', ph).filter(function (e) {
        return /flex:1/.test(e.getAttribute('style') || '') && /^Photos\b/.test(norm(e.textContent));
      })[0];
      var badge = head && $$('span', head).filter(function (e) {
        return /^[0-9]+$/.test(norm(e.textContent));
      })[0];
      if (badge) countRefs.push(function (n) { badge.textContent = String(n); });
      else MISS.push('photos :: header count');

      var all = sel(ph, 'All 24')[0];
      if (all) countRefs.push(function (n) { all.textContent = 'All ' + n; });

      /* Before and After were fixed numbers on a screen where the type is
         now the technician's to set, so filing a before shot left the chip
         saying four. Each chip counts its own. */
      var typeChips = {
        Before: sel(ph, 'Before 4')[0],
        After: sel(ph, 'After 20')[0]
      };
      if (!typeChips.Before || !typeChips.After) MISS.push('photos :: type chips');
      paintTypeCounts = function () {
        Object.keys(typeChips).forEach(function (k) {
          if (typeChips[k]) typeChips[k].textContent = k + ' ' + (photoTypeCount[k] || 0);
        });
      };
      paintTypeCounts();
    }
  })();
  function paintPhotoCount() {
    countRefs.forEach(function (f) { f(photoCount); });
    remember('photoCount', photoCount);
  }
  paintPhotoCount();

  var upTimer = null, upPending = 0, upToken = 0, upLastBound = null;

  function startUpload(n, bound) {
    // Each run owns a token; a leftover interval from an earlier upload sees a
    // stale token and stops itself instead of finishing this one with its own
    // long-expired start time.
    var my = ++upToken;
    var what = bound ? 'slot ' + bound.slot : n + ' ' + plural(n);
    upLastBound = bound || null;
    clearInterval(upTimer); clearTimeout(netHide);
    upPending = n;
    // no signal: the offline line already counts it, and it resumes on reconnect
    if (!net.online) { up.phase = 'idle'; paintNet(); return; }

    // progress is driven off elapsed time, not tick count — a backgrounded tab
    // throttles timers, and a bar that crawls because of that is a lie
    var t0 = Date.now(), DUR = 2000;
    up.phase = 'uploading'; up.pct = 0; up.text = 'Uploading ' + what + '…';
    paintNet();
    var iv = setInterval(function () {
      if (my !== upToken) { clearInterval(iv); return; }
      if (!net.online) { clearInterval(iv); up.phase = 'idle'; paintNet(); return; }
      up.pct = Math.min(100, (Date.now() - t0) / DUR * 100);
      if (up.pct >= 100) {
        clearInterval(iv);
        photoCount += upPending;
        upPending = 0;
        paintPhotoCount();
        up.phase = 'done';
        up.text = bound ? 'Slot ' + bound.slot + ' uploaded · ' + slotCount() + ' of ' + TOTAL_SLOTS + ' slots'
          : n + ' ' + plural(n) + ' uploaded';
        paintNet();
        flashThenHide(2400);
        return;
      }
      paintNet();
    }, 120);
    upTimer = iv;
  }

  /* What's still outstanding, said on the closeout screen itself rather than
     in a toast that's gone in two seconds. */
  var closeoutBlocker = null;
  function paintCloseoutBlocker() {
    var root = byId('closeout'); if (!root) return;
    var sc = $('.sc', root); if (!sc) return;
    if (!closeoutBlocker) {
      closeoutBlocker = document.createElement('div');
      closeoutBlocker.setAttribute('style',
        'display:flex;align-items:flex-start;gap:9px;background:#FDECEC;border:1px solid #F5C2C2;' +
        'border-radius:11px;padding:12px 13px;margin-bottom:12px');
      sc.insertBefore(closeoutBlocker, sc.firstElementChild);
    }
    closeoutBlocker.hidden = upPending === 0;
    if (upPending === 0) return;

    var offline = !net.online;
    closeoutBlocker.style.background = offline ? '#FEF3E2' : '#FDECEC';
    closeoutBlocker.style.borderColor = offline ? '#F3D9AE' : '#F5C2C2';
    closeoutBlocker.innerHTML =
      '<span class="mi" style="font-size:18px;color:' + (offline ? '#D97706' : '#DC2626') + ';margin-top:1px">' +
      (offline ? 'cloud_off' : 'sync') + '</span>' +
      '<div style="font:400 12.5px/1.45 Geist;color:' + (offline ? '#7A5B12' : '#8C2020') + '">' +
      (offline
        ? upPending + ' ' + plural(upPending) + ' still on the phone — they send when you have signal. You can close.'
        : upPending + ' ' + plural(upPending) + ' still uploading — give it a moment before closing.') +
      '</div>';
  }

  /* =========================================================
     US-M12-5 / W-13 — a Report Card photo is bound to its slot at the
     moment it's taken. Unlabelled photos are why dispatch opens and tags
     every single one before the tech can get their next call.
     ========================================================= */
  var RC_PHOTO_SCREENS = ['rc-section', 'rc-furnace', 'rc-condenser', 'rc-refrigerant', 'rc-tech'];
  var TOTAL_SLOTS = 14;
  var filledSlots = recall('slots', {});
  var pendingSlot = null;

  function readSlot(cam) {
    var card = cam.closest('div[style*="border-radius:12px"]');
    if (!card) return null;
    var chip = $$('span', card).filter(function (e) {
      return /^P\d+(\s*,\s*\d+)*$/.test(norm(e.textContent));
    })[0];
    if (!chip) return null;
    var num = $$('span', card).filter(function (e) { return /^\d+$/.test(norm(e.textContent)); })[0];
    var name = $$('span', card).filter(function (e) {
      return /flex:1/.test(e.getAttribute('style') || '') && norm(e.textContent);
    })[0];
    return {
      slot: norm(chip.textContent),
      item: (num ? norm(num.textContent) + ' · ' : '') + (name ? norm(name.textContent) : 'Report Card'),
      chip: chip, cam: cam
    };
  }

  function markSlotFilled(binding) {
    filledSlots[binding.slot] = true;
    binding.chip.style.background = '#E8F6ED';
    binding.chip.style.color = '#15803D';
    binding.chip.textContent = binding.slot + ' ✓';
    binding.cam.className = 'mif';
    binding.cam.style.color = '#16A34A';
    remember('slots', filledSlots);
  }

  function slotCount() { return Object.keys(filledSlots).length; }

  RC_PHOTO_SCREENS.forEach(function (id) {
    var root = byId(id); if (!root) return;
    byIcon(root, 'photo_camera').forEach(function (cam) {
      var binding = readSlot(cam);
      if (!binding) return;                     // no slot chip — an unbound photo
      if (filledSlots[binding.slot]) markSlotFilled(binding);   // taken before the reload
      cam.addEventListener('click', function () { pendingSlot = binding; }, true);
    });
  });

  /* Anything reached from outside the Report Card is an unbound photo. */
  ['home-active', 'photos', 'job-general', 'chat-thread', 'pay-check'].forEach(function (id) {
    var root = byId(id); if (!root) return;
    $$('[data-go="ov-media-source"]', root).forEach(function (e) {
      e.addEventListener('click', function () { pendingSlot = null; }, true);
    });
  });

  /* =========================================================
     Labelling at capture, and more than one at a time.

     The Before / After control on the description screen was drawn but
     inert, so whatever the technician picked, nothing carried it. And
     every photo cost a full trip through the sheet, the picker and the
     form — four taps each, standing in a plant room, for a job that
     wants a dozen.

     The label now travels with the save, the gallery hands over as many
     as were ticked under one label and one description, and the photos
     appear in the job's media strip wearing it.
     ========================================================= */
  var GAL_TILES = 12;
  var galPicked = [];
  var mediaBatch = 1;                // how many the next save is filing

  var GAL_ON = 'position:absolute;top:5px;right:5px;font-size:21px;color:#4A6FA5;' +
    'background:#fff;border-radius:11px';
  var GAL_OFF = 'position:absolute;top:5px;right:5px;font-size:21px;color:#fff;' +
    'background:rgba(28,43,58,.32);border-radius:11px';
  var GAL_DONE_ON = 'height:50px;padding:0 22px;display:flex;align-items:center;' +
    'background:#4A6FA5;color:#fff;border-radius:10px;font:600 15px/1 Geist';
  var GAL_DONE_OFF = 'height:50px;padding:0 22px;display:flex;align-items:center;' +
    'background:#EDF0F5;color:#A9B4C2;border-radius:10px;font:600 15px/1 Geist';

  function galClear() {
    galPicked = [];
    paintGallery();
  }
  function paintGallery() {
    var grid = byId('galGrid'); if (!grid) return;
    $$('[data-gal]', grid).forEach(function (t) {
      var on = galPicked.indexOf(t.dataset.gal) > -1;
      var tick = $('[data-galtick]', t);
      tick.textContent = on ? 'check_circle' : 'radio_button_unchecked';
      tick.className = (on ? 'mif' : 'mi');
      tick.setAttribute('style', on ? GAL_ON : GAL_OFF);
      t.style.outline = on ? '2.5px solid #4A6FA5' : '';
      t.style.outlineOffset = on ? '-2.5px' : '';
    });
    var n = galPicked.length;
    var c = byId('galCount');
    if (c) c.textContent = n ? n + ' ' + plural(n) + ' picked' : 'Nothing picked yet';
    var d = byId('galDone');
    if (d) {
      d.setAttribute('style', n ? GAL_DONE_ON : GAL_DONE_OFF);
      d.textContent = n ? 'Add ' + n : 'Add';
    }
    var all = byId('galAll');
    if (all) all.textContent = n === GAL_TILES ? 'Clear' : 'Select all';
  }

  (function () {
    var grid = byId('galGrid'); if (!grid) { MISS.push('gallery :: grid'); return; }
    for (var i = 0; i < GAL_TILES; i++) {
      var t = document.createElement('div');
      t.dataset.tap = '1';
      t.dataset.gal = String(i);
      t.setAttribute('style', 'position:relative;aspect-ratio:1;border-radius:10px;' +
        'background:' + (i % 3 ? '#E4E9F1' : '#D8DFEA') + ';display:flex;' +
        'align-items:center;justify-content:center;overflow:hidden');
      t.innerHTML = '<span class="mi" style="font-size:30px;color:#A9B4C2">image</span>' +
        '<span data-galtick class="mi"></span>';
      grid.appendChild(t);
    }
    grid.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-gal]'); if (!t) return;
      ev.stopPropagation();
      var k = t.dataset.gal, at = galPicked.indexOf(k);
      if (at > -1) galPicked.splice(at, 1); else galPicked.push(k);
      paintGallery();
    }, true);

    var all = byId('galAll');
    if (all) all.addEventListener('click', function (ev) {
      ev.stopPropagation();
      galPicked = galPicked.length === GAL_TILES
        ? []
        : $$('[data-gal]', grid).map(function (t) { return t.dataset.gal; });
      paintGallery();
    }, true);

    var done = byId('galDone');
    if (done) { done.dataset.tap = '1'; done.dataset.act = 'galDone'; }
    paintGallery();
  })();

  /* A saved photo shows up in the job's media strip wearing its label —
     otherwise the only proof anything happened is a toast that's gone in
     two seconds. */
  function addMediaThumbs(n) {
    var root = byId('job-general'); if (!root) return;
    var head = sel(root, 'Media')[0];
    var card = head && head.parentElement && head.parentElement.parentElement;
    if (!card) { MISS.push('job-general :: media strip'); return; }
    var strip = head.parentElement.nextElementSibling;
    var tiles = $$(':scope > div', strip);
    var tpl = tiles[0], addTile = tiles[tiles.length - 1];
    if (!tpl || !addTile || tpl === addTile) { MISS.push('job-general :: media tiles'); return; }
    for (var i = 0; i < n; i++) {
      var t = tpl.cloneNode(true);
      // no label was chosen at capture, so the thumb does not claim one
      var badge = $$('span', t).filter(function (e) {
        return /position:absolute/.test(e.getAttribute('style') || '');
      })[0];
      if (badge) badge.remove();
      strip.insertBefore(t, addTile);
    }
    var count = head.parentElement.lastElementChild;
    if (count && /^[0-9]+$/.test(norm(count.textContent))) {
      count.textContent = String((parseInt(count.textContent, 10) || 0) + n);
    }
    // the strip would grow past the card; let it scroll instead
    strip.style.overflowX = 'auto';
    strip.classList.add('sc');
  }

  /* The job's media strip got the new thumbs and the gallery did not, so
     saving a photo and opening Photos showed the same twenty-four tiles the
     board drew. Newest first, wearing its type when one was chosen. */
  function addPhotoTiles(n, type) {
    var root = byId('photos'); if (!root) return;
    var grid = $$('.sc > div', root).filter(function (e) {
      return /grid-template-columns/.test(e.getAttribute('style') || '');
    })[0];
    var tpl = grid && grid.firstElementChild;
    if (!tpl) { MISS.push('photos :: grid'); return; }
    for (var i = 0; i < n; i++) {
      var t = tpl.cloneNode(true);
      var badge = $$('span', t).filter(function (e) {
        return /position:absolute/.test(e.getAttribute('style') || '');
      })[0];
      if (badge) {
        // no type was asked for on a batch, so the tile does not claim one
        if (type) badge.textContent = type.toUpperCase(); else badge.remove();
      }
      grid.insertBefore(t, grid.firstElementChild);
    }
  }

  /* How many this save is filing, and — when a Report Card slot owns the
     photo — that Before / After is not the technician's call here. */
  var mediaCaption = null;
  var mediaEditing = false;      // one photo being described, not a batch saved
  var mediaHeading = null, mediaTypeField = null;

  (function () {
    /* One Before / After for a whole batch is a trap: you tick four photos,
       hit Save, and only then remember two of them were the before shots.
       So capture no longer claims to know — the control is gone from the
       save, and the type is set on the photo itself, which is where the
       board puts it: a field reading "Image type · After" on the screen you
       reach from the photo. A Report Card photo is never typed this way
       anyway; its slot names it. */
    var root = byId('image-desc'); if (!root) return;
    var sc = $('.sc', root);
    // scoped to the body: the screen's own title reads 'Image description'
    // too, and matching that turned the Save button into a form field
    if (!sc) { MISS.push('image-desc :: form'); return; }
    var typeLabel = sel(sc, 'Image type')[0];
    var typeRow = typeLabel && typeLabel.nextElementSibling;
    var descLabel = sel(sc, 'Image description')[0];
    var descBox = descLabel && descLabel.nextElementSibling;
    if (!typeLabel || !typeRow || !descLabel || !descBox) { MISS.push('image-desc :: form'); return; }

    mediaHeading = document.createElement('div');
    mediaHeading.setAttribute('style', 'font:600 17px/1.3 Geist;color:#1A2332;margin-bottom:14px');
    mediaHeading.textContent = 'Change image description';
    sc.insertBefore(mediaHeading, sc.firstElementChild);

    // a filled field carries its own label, so the one above it goes
    var FIELD = 'display:block;background:#EDF0F5;border-radius:10px 10px 0 0;' +
      'border-bottom:1.5px solid #8A97A8;padding:11px 14px 10px';
    typeLabel.remove();
    typeRow.dataset.tap = '1';
    typeRow.dataset.go = 'ov-imagetype';
    typeRow.dataset.mode = 'overlay';
    typeRow.setAttribute('style', FIELD + ';margin-bottom:18px');
    typeRow.innerHTML = '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="flex:1"><div style="font:400 12px/1 Geist;color:#546478">Image type</div>' +
      '<div data-typeval style="font:400 16px/1.25 Geist;color:#1A2332;margin-top:5px"></div></div>' +
      '<span class="mi" style="font-size:22px;color:#546478">expand_more</span></div>';
    mediaTypeField = typeRow;

    descLabel.remove();
    descBox.setAttribute('style', FIELD + ';min-height:96px');
    var dv = descBox.textContent;
    descBox.innerHTML = '<div style="font:400 12px/1 Geist;color:#546478">Image description</div>' +
      '<div data-descval style="font:400 16px/1.45 Geist;color:#1A2332;margin-top:5px"></div>';
    $('[data-descval]', descBox).textContent = norm(dv);
  })();

  /* the three rows of the type sheet */
  (function () {
    var list = byId('imgTypeList'); if (!list) return;
    // not every shot is a before or an after — a nameplate, a meter
    // reading, the parking space the van has to fit in
    ['Before', 'After', 'Other'].forEach(function (t) {
      var r = document.createElement('div');
      r.dataset.tap = '1';
      r.dataset.imgtype = t;
      r.setAttribute('style', 'display:flex;align-items:center;gap:12px;padding:16px 18px;' +
        'font:500 15.5px/1 Geist;border-bottom:1px solid #EDF0F5');
      r.innerHTML = '<span class="mif" style="font-size:20px;color:#4A6FA5;width:22px">check</span>' +
        '<span></span>';
      r.children[1].textContent = t;
      list.appendChild(r);
    });
    list.addEventListener('click', function (ev) {
      var r = ev.target.closest('[data-imgtype]'); if (!r) return;
      ev.stopPropagation();
      photoType = r.dataset.imgtype;
      remember('photoType', photoType);
      paintPhotoType();
      closeOverlays(false);
      toast('Filed as ' + photoType.toLowerCase(), 'photo_library');
    }, true);
  })();

  function paintMediaForm() {
    var root = byId('image-desc'); if (!root) return;
    var sc = $('.sc', root); if (!sc) return;

    if (!mediaCaption) {
      mediaCaption = document.createElement('div');
      mediaCaption.setAttribute('style',
        'font:500 13.5px/1.4 Geist;color:#546478;margin:-12px 0 18px;text-align:center');
      var preview = $$(':scope > div', sc).filter(function (e) {
        return /height:200px/.test(e.getAttribute('style') || '');
      })[0];
      if (preview) preview.parentElement.insertBefore(mediaCaption, preview.nextElementSibling);
    }
    if (mediaCaption) {
      var n = Math.max(1, mediaBatch);
      mediaCaption.hidden = n < 2;
      mediaCaption.textContent = n + ' ' + plural(n) +
        ' — one description for all of them, and a type each afterwards';
    }
    /* The type belongs to a photo. What could not be asked was one type
       for a batch of four — but a single shot is one photo, so it is asked
       the moment there is only one to ask about: straight off the camera,
       a gallery pick of one, or a photo being described later. A batch of
       several is typed per photo afterwards, in the viewer. */
    if (mediaTypeField) toggleDisplay(mediaTypeField, mediaEditing || Math.max(1, mediaBatch) === 1);
    if (mediaHeading) {
      mediaHeading.textContent = mediaEditing
        ? 'Change image description'
        : 'Describe what you shot';
    }
    paintPhotoType();
  }

  /* The binding is stated on the description screen, so the tech sees what
     the photo will be filed against before saving it. */
  var slotBanner = null;
  function paintSlotBanner() {
    var root = byId('image-desc'); if (!root) return;
    var sc = $('.sc', root) || root;
    if (!slotBanner) {
      slotBanner = document.createElement('div');
      slotBanner.setAttribute('style',
        'display:flex;align-items:flex-start;gap:9px;background:#EBF0F8;border:1px solid #C8D5E8;' +
        'border-radius:11px;padding:12px 13px;margin-bottom:12px');
      sc.insertBefore(slotBanner, sc.firstElementChild);
    }
    slotBanner.hidden = !pendingSlot;
    if (!pendingSlot) return;
    slotBanner.innerHTML =
      '<span class="mi" style="font-size:18px;color:#4A6FA5;margin-top:1px">link</span>' +
      '<div style="font:400 13px/1.4 Geist;color:#546478">Report Card · <b style="font-weight:600;color:#1A2332">' +
      pendingSlot.item + '</b> · slot <b style="font-weight:600;color:#1A2332">' + pendingSlot.slot + '</b></div>';
  }

  /* =========================================================
     A dashboard that moves. Sign an estimate and Conversions and Closing
     tick up; take a payment and Revenue does. The seeds are the design's
     own figures (22.5% of 14, 27% of 14), kept as fractions so the first
     paint shows exactly what the mockup shows.
     ========================================================= */
  var kpi = Object.assign({
    revenue: 65200, target: 300000,
    estValue: 420000, estimates: 14, conv: 0.225 * 14,
    closed: 0.27 * 14, closeTarget: 45,
    avgTicket: 1200, avgTarget: 2000
  }, recall('kpi', {}));

  function kfmt(n) {                      // the mockup writes $65,2k — comma decimal
    return '$' + (n / 1000).toFixed(1).replace('.', ',') + 'k';
  }
  var kpiRefs = null;

  /* =========================================================
     The corner of a KPI card.

     It held an n/14 chip that nothing in the app explained — a technician
     reading "7/14" cannot tell whether it is a rank, a countdown or a
     quota. What belongs in that corner is the one thing a single figure
     can never say: which way it is going.

     The design says this with one arrow, and it is right to: a polyline
     46 pixels wide drawn through six points is a shape nobody can read at
     arm's length — it only looks crooked. The arrow reads at a glance.

     Six periods behind it, the last of them live, so taking a payment can
     turn Revenue's arrow under your thumb. Green while a metric improves,
     red while it slides, because up is the good direction on all four.
     ========================================================= */
  var TREND = {
    rev: [38, 44, 41, 52, 58, 65.2],            // $k
    est: [18.5, 20.1, 19.4, 21.8, 22.0, 22.5],  // conversion %
    avg: [1.45, 1.38, 1.30, 1.26, 1.22, 1.20],  // $k per ticket
    close: [31, 29, 33, 30, 28, 27]             // closing %
  };
  var sparks = {};

  function trendNow(k) {
    if (k === 'rev') return kpi.revenue / 1000;
    if (k === 'est') return kpi.conv / kpi.estimates * 100;
    if (k === 'avg') return kpi.avgTicket / 1000;
    return kpi.closed / kpi.estimates * 100;
  }

  function paintSparks() {
    Object.keys(sparks).forEach(function (k) {
      var series = TREND[k].slice();
      var now = trendNow(k), was = series[0];
      var up = now >= was;
      var el = sparks[k];
      el.textContent = up ? 'trending_up' : 'trending_down';
      el.style.color = up ? '#16A34A' : '#DC2626';
      el.title = (up ? 'Up' : 'Down') + ' over the last ' + series.length + ' periods';
    });
  }

  (function () {
    var root = byId('home'); if (!root) return;
    // the card is named by its own label, not by the order it was drawn in
    var KEYS = [['Revenue', 'rev'], ['Conversions', 'est'],
      ['per ticket', 'avg'], ['percentage', 'close']];
    $$('span', root).forEach(function (e) {
      if (!/^[0-9]{1,2}[/]14$/.test(norm(e.textContent)) || e.children.length) return;
      var head = e.parentElement;
      var label = head.firstElementChild ? norm(head.firstElementChild.textContent) : '';
      var key = null;
      KEYS.forEach(function (k) { if (!key && label.indexOf(k[0]) > -1) key = k[1]; });
      if (!key) { e.remove(); return; }
      var holder = document.createElement('span');
      holder.className = 'mi';
      holder.setAttribute('style', 'flex:none;font-size:19px;line-height:1');
      head.replaceChild(holder, e);
      sparks[key] = holder;
    });
    if (Object.keys(sparks).length < 4) MISS.push('home :: kpi trends');
  })();

  function kpiRefsGet() {
    if (kpiRefs) return kpiRefs;
    var home = byId('home'); if (!home) return null;
    function card(text) {
      var v = sel(home, text)[0]; if (!v) return null;
      var c = v.closest('div[style*="border-radius:12px"]');
      return { value: v, bar: c ? $('div[style*="height:5px"] > div', c) : null, card: c };
    }
    kpiRefs = {
      rev: card('$65,2k / $300k'),
      est: card('$420k'),
      avg: card('$1,2k / $2,0k'),
      avgNote: sel(byId('home'), 'Below target')[0],
      close: card('27% / 45%'),
      convPct: sel(home, '22.5%')[0],
      estCount: sel(home, 'Of 14 estimates')[0]
    };
    return kpiRefs;
  }
  function setLead(el, lead) {            // "$65,2k <span>/ $300k</span>" — only the lead changes
    if (!el) return;
    var t = el.firstChild;
    if (t && t.nodeType === 3) t.nodeValue = lead + ' '; else el.textContent = lead;
  }
  function paintKPI() {
    var r = kpiRefsGet(); if (!r) return;
    var pct = function (a, b) { return Math.max(0, Math.min(100, a / b * 100)); };
    if (r.rev) { setLead(r.rev.value, kfmt(kpi.revenue)); if (r.rev.bar) r.rev.bar.style.width = pct(kpi.revenue, kpi.target) + '%'; }
    if (r.est) {
      r.est.value.textContent = '$' + Math.round(kpi.estValue / 1000) + 'k';
      var cp = kpi.conv / kpi.estimates * 100;
      if (r.convPct) r.convPct.textContent = cp.toFixed(1) + '%';
      if (r.est.bar) r.est.bar.style.width = pct(cp, 100) + '%';
    }
    if (r.avg) {
      setLead(r.avg.value, kfmt(kpi.avgTicket));
      if (r.avg.bar) r.avg.bar.style.width = pct(kpi.avgTicket, kpi.avgTarget) + '%';
      // the caption was fixed at "Below target" however big the tickets got
      if (r.avgNote) {
        r.avgNote.textContent = kpi.avgTicket >= kpi.avgTarget ? 'On target' : 'Below target';
      }
    }
    if (r.close) {
      var cl = kpi.closed / kpi.estimates * 100;
      setLead(r.close.value, Math.round(cl) + '%');
      if (r.close.bar) r.close.bar.style.width = pct(cl, kpi.closeTarget) + '%';
      if (r.estCount) r.estCount.textContent = 'Of ' + kpi.estimates + ' estimates';
    }
    paintSparks();
    remember('kpi', kpi);
  }
  function kpiSale(total) {
    kpi.conv += 1; kpi.closed += 1;
    kpi.estValue += total;
    kpi.avgTicket = (kpi.avgTicket * (kpi.closed - 1) + total) / kpi.closed;
    paintKPI();
  }
  function kpiPaid(amount) { kpi.revenue += amount; paintKPI(); }
  paintKPI();

  /* =========================================================
     US-M03-9 (policy) — a technician works one job at a time: the one
     they are driving to or standing on. The queue is still theirs to look
     at before the day starts, which is what the design's "2 of 3" pager
     does, but the moment a job goes live the pager leaves and the card is
     the current job until it is closed out.
     ========================================================= */
  /* A job doesn't always start blank. An install visit arrives with the
     estimate the sales advisor already sold, so the tech's job is the work
     and the invoice, not building a quote. Each job carries its own state. */
  var JOBS = [
    {
      name: 'Randy Johnson', when: 'Today, 8:00 AM', brief: 'AC not cooling', type: 'Estimate',
      addr: '5010 N Cortez Ave, Tampa, FL 33614', away: '3.92 miles away', phone: '(813) 456-7890',
      est: 'none', inv: 'none',
      // no estimate on this one, so the job's own items are what it's worth
      items: [jobLine('SV-2007', 1), jobLine('MT-2002', 2)], sold: null
    },
    {
      name: 'Brent Kenzie', when: 'Today, 11:30 AM', brief: 'System replacement', type: 'Install',
      addr: '4407 Main St, Brandon, FL 33594', away: '11.4 miles away', phone: '(727) 415-3481',
      est: 'approved', inv: 'none',         // sold last week — go straight to the work
      // sold as a package: the items came across with the approval
      items: [
        jobLine('SV-3001', 1, 'estimate'), jobLine('MT-3101', 1, 'estimate'),
        jobLine('EQ-3201', 1, 'estimate'), jobLine('MT-3102', 1, 'estimate'),
        jobLine('MT-3103', 1, 'estimate'), jobLine('AD-3301', 1, 'estimate'),
        jobLine('AS-3401', 1, 'estimate')
      ],
      sold: { option: 'Option A', total: 5665 }
    },
    {
      name: 'Joseph Lane', when: 'Today, 2:15 PM', brief: 'AC not cooling', type: 'Demand Service',
      addr: '255 Standish Drive, Tampa, FL 33615', away: '6.8 miles away', phone: '(352) 258-9710',
      est: 'ready', inv: 'none',            // advisor quoted it, still to present
      items: [jobLine('SV-2007', 1)], sold: null
    }
  ];

  /* =========================================================
     The job's items.

     Two rules, both Marek's, when asked whether a job's price comes from
     the estimate or from the items: "It should be both." With an approved
     estimate the signed option is the price — the customer agreed to a
     number, not to a shopping list. Without one, the job is worth what its
     items are worth at their own unit prices.

     Each line stands alone: what it is, what it cost, how many. The
     quantity is the part that changes on site, so it is a stepper rather
     than a number printed on a chip.
     ========================================================= */
  var jobItemsRefs = null;
  (function () {
    var root = byId('job-general'); if (!root) return;
    var head = sel(root, 'Items')[0];
    if (!head) { MISS.push('job-general :: items'); return; }
    var headRow = head.parentElement, card = headRow.parentElement;
    var addBtn = card && card.lastElementChild;
    if (!card || !addBtn || addBtn === headRow) { MISS.push('job-general :: items card'); return; }
    jobItemsRefs = { card: card, count: headRow.lastElementChild, add: addBtn };
    // the design's two placeholder rows are a mock-up — real items replace them
    $$(':scope > div', card).forEach(function (e) {
      if (e !== headRow && e !== addBtn) e.remove();
    });
  })();

  function jobLabor(j) {
    return ((j && j.items) || []).reduce(function (a, it) { return a + it.labor * it.qty; }, 0);
  }
  function jobItemsTotal(j) {
    return ((j && j.items) || []).reduce(function (a, it) { return a + it.price * it.qty; }, 0);
  }
  function mergeItems(into, add) {
    add.forEach(function (it) {
      var seen = it.sku && into.filter(function (o) { return o.sku === it.sku; })[0];
      if (seen) seen.qty += it.qty || 1;
      else into.push(it);
    });
    return into;
  }
  function jobAddPicked(picked) {
    var j = JOBS[jobIdx];
    if (!j) { back(); return; }
    j.items = mergeItems(j.items || [], picked.map(function (it) {
      return {
        sku: it.sku, name: it.name, type: it.type, cat: it.cat,
        price: it.price, labor: it.labor, qty: 1, from: 'manual'
      };
    }));
    renderJobItems();
    back();
    toast(picked.length
      ? picked.length + (picked.length === 1 ? ' item' : ' items') + ' added to the job'
      : 'Nothing selected', picked.length ? 'check_circle' : 'info');
  }

  var QTY_CHIP = 'display:inline-block;margin-top:6px;font:600 12.5px/1 Geist;color:#546478;' +
    'background:#EDF0F5;border-radius:5px;padding:5px 8px';

  /* Quantity is the thing that changes on site — two filters instead of
     one, a second pound of refrigerant. It was a flat "Qty: 2" chip, so
     the only way to correct it was to delete the line and add it again.
     It gets the same stepper the option builder uses, and the line, the
     total and the count all move with it. */
  function jobItemRow(it, idx) {
    var row = document.createElement('div');
    row.setAttribute('data-jobitem', '1');
    row.setAttribute('style', 'padding:12px 0;border-top:1px solid #EDF0F5');
    var meta = [it.sku, it.cat].filter(Boolean).join(' \u00b7 ');
    if (it.from === 'estimate') meta += (meta ? ' \u00b7 ' : '') + 'from the estimate';

    row.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
      '<div style="flex:1">' +
      '<div data-nm style="font:500 14.5px/1.3 Geist"></div>' +
      '<div data-meta style="font:400 12.5px/1.35 Geist;color:#8A97A8;margin-top:4px"></div>' +
      '<div data-chip style="margin-top:7px"></div>' +
      '</div>' +
      '<div data-price style="font:600 14.5px/1 Geist;flex:none;text-align:right"></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:11px">' +
      '<div style="display:flex;align-items:center;border:1px solid #DDE3EE;border-radius:9px;overflow:hidden">' +
      '<div data-minus style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:#4A6FA5"><span class="mi" style="font-size:19px">remove</span></div>' +
      '<div data-qty style="min-width:34px;text-align:center;font:600 14.5px/1 Geist;border-left:1px solid #DDE3EE;border-right:1px solid #DDE3EE;line-height:40px"></div>' +
      '<div data-plus style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:#4A6FA5"><span class="mi" style="font-size:19px">add</span></div>' +
      '</div>' +
      '<span data-unit style="font:400 12.5px/1 Geist;color:#8A97A8"></span>' +
      '<div data-drop style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:#A9B4C2;flex:none;margin-right:-8px"><span class="mi" style="font-size:19px">delete_outline</span></div>' +
      '</div>';

    $('[data-nm]', row).textContent = it.name;
    $('[data-meta]', row).textContent = meta;
    $('[data-chip]', row).innerHTML = typeChip(it.type);
    $('[data-unit]', row).textContent = fmt(it.price) + ' each';

    function paintRow() {
      $('[data-qty]', row).textContent = String(it.qty);
      $('[data-price]', row).textContent = fmt(it.price * it.qty);
      $('[data-minus]', row).style.opacity = it.qty > 1 ? '' : '.35';
    }
    paintRow();

    [['[data-minus]', -1], ['[data-plus]', 1]].forEach(function (p) {
      var b = $(p[0], row);
      b.dataset.tap = '1';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var next = it.qty + p[1];
        if (next < 1) return;
        it.qty = next;
        paintRow();
        saveJobs();
        paintJobTotal();
      }, true);
    });

    var drop = $('[data-drop]', row);
    drop.dataset.tap = '1';
    drop.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var j = JOBS[jobIdx]; if (!j) return;
      j.items.splice(idx, 1);
      saveJobs();
      renderJobItems();
      toast('Item removed from the job', 'delete_outline');
    }, true);

    return row;
  }

  function saveJobs() {
    remember('jobs', JOBS.map(function (j) {
      return { est: j.est, inv: j.inv, items: j.items, sold: j.sold };
    }));
  }

  var jobTotalEl = null;
  /* Only the money moves when a quantity does — rebuilding every row would
     throw away the stepper the finger is still on. */
  function paintJobTotal() {
    if (!jobTotalEl) return;
    var j = JOBS[jobIdx] || {};
    var tot = $('[data-tot]', jobTotalEl);
    if (tot) tot.textContent = fmt(j.sold ? j.sold.total : jobItemsTotal(j));
  }

  function renderJobItems() {
    if (!jobItemsRefs) return;
    var R = jobItemsRefs, j = JOBS[jobIdx] || {}, items = j.items || [];
    $$('[data-jobitem]', R.card).forEach(function (e) { e.remove(); });
    if (R.count) R.count.textContent = String(items.length);

    if (!items.length) {
      var empty = document.createElement('div');
      empty.setAttribute('data-jobitem', '1');
      empty.setAttribute('style', 'padding:13px 0 3px;border-top:1px solid #EDF0F5;' +
        'font:400 13.5px/1.5 Geist;color:#8A97A8');
      empty.textContent = 'Nothing on this job yet. Whatever the customer approves on an estimate lands here on its own.';
      R.card.insertBefore(empty, R.add);
    }
    items.forEach(function (it, i) { R.card.insertBefore(jobItemRow(it, i), R.add); });

    var sold = j.sold;
    var total = sold ? sold.total : jobItemsTotal(j);
    var foot = document.createElement('div');
    jobTotalEl = foot;
    foot.setAttribute('data-jobitem', '1');
    foot.setAttribute('style', 'display:flex;justify-content:space-between;align-items:flex-start;' +
      'gap:10px;padding:13px 0 3px;border-top:1px solid #C8D5E8;margin-top:2px');
    foot.innerHTML = '<div><div style="font:600 14.5px/1 Geist">Total</div>' +
      '<div data-src style="font:400 11.5px/1.4 Geist;color:#8A97A8;margin-top:5px"></div></div>' +
      '<span data-tot style="font:700 17px/1 Geist;white-space:nowrap"></span>';
    $('[data-src]', foot).textContent = sold
      ? sold.option + ' approved — the signed estimate sets the price'
      : 'Job items at unit price — no estimate on this job';
    $('[data-tot]', foot).textContent = fmt(total);
    R.card.insertBefore(foot, R.add);
  }

  goBacks = recall('goBacks', []);

  if (recall('declined', false)) markDeclined();

  /* =========================================================
     Pricing preview: what the customer is actually shown.

     Three radios and an "Add extra notes" that did nothing, under a
     label — "Pricing preview type" — that does not say whose preview or
     when they would see it. It decides what lands on the option card at
     the customer's kitchen table: the monthly, the total, or both.

     So it drives the cards. Total only strips the monthly and its
     toggle; monthly only strips the total. Choosing something the plan
     cannot deliver is not possible — with no financing there is no
     monthly to show.
     ========================================================= */
  var PREVIEW = ['both', 'total', 'monthly'];
  var previewMode = 'both';
  function paintOptionName() {
    var e = $('[data-optname]'); if (!e) return;
    e.textContent = 'Option ' + String.fromCharCode(65 + Math.min(optCount, 25));
  }

  /* =========================================================
     Two fields at the top of a new option.

     Three radio rows took a third of the screen to say one thing, above
     the items they were describing — the board draws a field with the
     answer in it and a chevron. The rows themselves are good rows, so
     they move into a sheet rather than being redrawn, and keep the wiring
     they already had.

     The name beside them is the letter the option will be given. It is a
     field so it reads like the one under it, and it is not editable: the
     letter is what every card, total and signature refers to.
     ========================================================= */
  /* The app writes a field as a white card with a hairline border — the
     closeout, the notes, the job card all do. A grey box with a heavy
     underline is a different app's furniture, so these two wear the same
     card as everything else.

     And a dropdown drops down. A bottom sheet is for a choice that
     deserves the whole screen; three words under the field you tapped do
     not, and the sheet covers the items the choice is about. */
  var FIELD = 'display:block;background:#fff;border:1px solid #DDE3EE;border-radius:11px;' +
    'padding:12px 14px;margin-bottom:12px';
  var FIELD_LABEL = 'font:500 12.5px/1 Geist;color:#546478';
  var FIELD_VALUE = 'font:500 15.5px/1.2 Geist;color:#1A2332;margin-top:7px';
  var previewField = null;

  (function () {
    var root = byId('est-new-option'); if (!root) return;
    var head = sel(root, 'Pricing preview type')[0];
    var nameLabel = sel(root, 'Option name')[0];
    var nameBox = nameLabel && nameLabel.nextElementSibling;
    if (!head) { MISS.push('est-new-option :: preview type'); return; }

    var rows = ['Monthly payment + Total', 'Total only', 'Monthly payment only']
      .map(function (l) { var e = sel(root, l)[0]; return e && e.parentElement; });
    if (rows.some(function (r) { return !r; })) { MISS.push('est-new-option :: preview rows'); return; }

    // the field takes the heading's place; the rows sit in a holder of their own
    var holder = head.parentElement;
    var field = document.createElement('div');
    field.dataset.tap = '1';
    field.setAttribute('style', FIELD + ';position:relative');
    field.innerHTML = '<div data-open style="display:flex;align-items:center;gap:10px">' +
      '<div style="flex:1"><div style="' + FIELD_LABEL + '">Pricing preview type</div>' +
      '<div data-previewval style="' + FIELD_VALUE + '"></div></div>' +
      '<span class="mi" data-chev style="font-size:22px;color:#546478">expand_more</span></div>';
    holder.insertBefore(field, head);
    head.remove();
    previewField = $('[data-previewval]', field);
    previewField.textContent = 'Monthly payment + Total';

    var panel = document.createElement('div');
    panel.hidden = true;
    panel.setAttribute('style', 'position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:40;' +
      'background:#fff;border:1px solid #C8D5E8;border-radius:11px;padding:4px;' +
      'box-shadow:0 10px 26px rgba(26,35,50,.18)');
    rows.forEach(function (r) { panel.appendChild(r); });
    field.appendChild(panel);

    var chev = $('[data-chev]', field);
    function close() { panel.hidden = true; chev.textContent = 'expand_more'; }
    field.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-seg]')) return;        // a choice, not the field
      ev.stopPropagation();
      panel.hidden = !panel.hidden;
      chev.textContent = panel.hidden ? 'expand_more' : 'expand_less';
    }, true);
    // anywhere else closes it, the way a dropdown does
    document.addEventListener('click', function (ev) {
      if (!panel.hidden && !field.contains(ev.target)) close();
    }, true);

    if (nameBox) {
      nameLabel.remove();
      nameBox.setAttribute('style', FIELD);
      var was = norm(nameBox.textContent);
      nameBox.innerHTML = '<div style="' + FIELD_LABEL + '">Option name</div>' +
        '<div data-optname style="' + FIELD_VALUE + '"></div>';
      $('[data-optname]', nameBox).textContent = was;
    }

    // the label is a span inside the row; the row is what carries the state
    seg('est-new-option',
      ['Monthly payment + Total^1', 'Total only^1', 'Monthly payment only^1'], 0,
      function (i, label) {
        previewMode = PREVIEW[i];
        if (previewField) previewField.textContent = label.split('^')[0];
        paintPlanEverywhere();
        close();
        toast(i === 0 ? 'Customer sees the monthly and the total'
          : i === 1 ? 'Customer sees the total only'
            : 'Customer sees the monthly only', 'visibility');
      });
  })();

  /* A note the technician wants on the option — a reason, a caveat, what
     the price does not cover. It rides with the option to the customer. */
  var optionNoteText = '';
  ACT.optionNote = function () {
    var root = byId('est-new-option'); if (!root) return;
    var btn = sel(root, '~Add extra notes')[0];
    if (!btn) { btn = sel(root, 'Add extra notes')[0]; }
    if (!btn || $('[data-optnote]', root)) return;
    var box = document.createElement('div');
    box.setAttribute('data-optnote', '1');
    box.setAttribute('style', 'margin-top:9px');
    box.innerHTML =
      '<textarea class="inp" rows="3" placeholder="Anything the customer should read with this price" ' +
      'style="height:auto;padding:11px 12px;font:400 14.5px/1.5 Geist;resize:none"></textarea>' +
      '<div style="display:flex;gap:9px;margin-top:9px">' +
      '<div data-ncancel style="flex:1;height:44px;display:flex;align-items:center;justify-content:center;' +
      'background:#fff;border:1px solid #C8D5E8;color:#546478;border-radius:10px;font:600 14px/1 Geist">Cancel</div>' +
      '<div data-nsave style="flex:1;height:44px;display:flex;align-items:center;justify-content:center;' +
      'background:#4A6FA5;color:#fff;border-radius:10px;font:600 14px/1 Geist">Save note</div></div>';
    var ta = $('textarea', box);
    ta.value = optionNoteText;
    btn.parentElement.insertBefore(box, btn.nextElementSibling);
    toggleDisplay(btn, false);
    setTimeout(function () { ta.focus(); }, 30);
    box.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (ev.target.closest('[data-ncancel]')) { box.remove(); toggleDisplay(btn, true); return; }
      if (!ev.target.closest('[data-nsave]')) return;
      optionNoteText = ta.value.trim();
      box.remove();
      toggleDisplay(btn, true);
      var txt = btn.childNodes[btn.childNodes.length - 1];
      if (txt && txt.nodeType === 3) {
        txt.nodeValue = optionNoteText ? 'Note added — tap to edit' : 'Add extra notes';
      }
      toast(optionNoteText ? 'Note saved with the option' : 'Note cleared', 'sticky_note_2');
    }, true);
  };

  /* ---- the plan card, and every monthly figure it drives ---- */
  var planRefs = null;
  (function () {
    var root = byId('est-draft'); if (!root) return;
    var head = sel(root, 'Plan selection')[0];
    // byText lands on the innermost match, so this is the label itself —
    // the tappable row is its parent
    var label = sel(root, 'Ally — 7.99% / 1.29%')[0];
    var drop = label && label.parentElement;
    var card = drop && drop.parentElement;
    if (!head || !label || !card) { MISS.push('est-draft :: plan card'); return; }

    // the heading never said what any of this was for
    var why = document.createElement('div');
    why.setAttribute('style', 'font:400 12.5px/1.45 Geist;color:#8A97A8;margin:-6px 0 10px');
    why.textContent = 'What the customer is quoted per month, and what they put down.';
    head.parentElement.insertBefore(why, head.nextElementSibling);

    drop.dataset.tap = '1';
    drop.dataset.go = 'ov-plan';
    drop.dataset.mode = 'overlay';

    var tiles = $$('div', card).filter(function (e) {
      return /background:#F5F7FA;border-radius:8px/.test(e.getAttribute('style') || '');
    });
    // the button carries an icon, so only its own text nodes identify it
    var down = sel(root, '~Add down payment')[0];
    planRefs = { label: label, tiles: tiles, down: down || null };
  })();

  function paintPlanCard() {
    if (!planRefs) return;
    var p = plan();
    if (planRefs.label) {
      planRefs.label.textContent = p.months
        ? p.name + ' — ' + p.rate.toFixed(2) + '% / ' + p.months + ' mo'
        : p.name;
    }
    var vals = [
      p.months ? (planFactor() * 100).toFixed(2) + '%' : '—',
      p.months ? p.rate.toFixed(2) + '%' : '—',
      p.months ? p.apr.toFixed(2) + '%' : '—',
      p.months ? p.months + ' months' : 'No financing'
    ];
    planRefs.tiles.forEach(function (t, i) {
      var v = t.lastElementChild;
      if (v && vals[i] !== undefined) v.textContent = vals[i];
    });
    if (planRefs.down) {
      var txt = planRefs.down.childNodes[planRefs.down.childNodes.length - 1];
      if (txt && txt.nodeType === 3) {
        txt.nodeValue = deposit ? 'Deposit ' + fmt(deposit) : 'Add deposit';
      }
    }
  }

  /* Every card's "/month" was a number from the mock-up, and the "Tap for
     monthly" it sits next to never did anything. Both are the same sum. */
  var PER_MONTH = '<span style="font:500 13px/1 Geist;color:#546478"> /month</span>';
  function paintOptionPrices(screenId) {
    var root = byId(screenId); if (!root) return;
    var cards = $$('div', root).filter(function (e) {
      return /border-radius:12px/.test(e.getAttribute('style') || '') && optionName(e);
    });
    cards = cards.filter(function (e) { return !cards.some(function (o) { return o !== e && o.contains(e); }); });
    cards.forEach(function (c) {
      var total = OPTION_TOTALS[optionName(c)] || 0;
      var hint = $$('span', c).filter(function (e) { return /^Tap for (total|monthly)$/.test(norm(e.textContent)); })[0];
      var priceEl = $$('span', c).filter(function (e) {
        return /^\$[\d,]+\.\d\d/.test(norm(e.textContent)) && /font:700/.test(e.getAttribute('style') || '');
      })[0];
      if (!priceEl) return;
      var canFinance = !!plan().months;
      // nothing to show a monthly from, or the technician chose not to
      if (hint && (!canFinance || previewMode === 'total')) {
        hint.hidden = true; priceEl.textContent = fmt(total); return;
      }
      if (hint && previewMode === 'monthly') {
        hint.hidden = true; priceEl.innerHTML = fmt(monthlyFor(total)) + PER_MONTH; return;
      }
      if (hint) hint.hidden = false;
      var showingMonthly = hint && /Tap for total/.test(norm(hint.textContent));
      if (showingMonthly) priceEl.innerHTML = fmt(monthlyFor(total)) + PER_MONTH;
      else priceEl.textContent = fmt(total);

      if (hint && !hint.dataset.tap) {
        hint.dataset.tap = '1';
        hint.addEventListener('click', function (ev) {
          ev.stopPropagation();
          hint.textContent = /Tap for total/.test(norm(hint.textContent)) ? 'Tap for monthly' : 'Tap for total';
          paintOptionPrices(screenId);
        }, true);
      }
    });
  }

  function paintPlanEverywhere() {
    paintPlanCard();
    ['est-draft', 'est-review', 'est-ready', 'est-customer'].forEach(paintOptionPrices);
    paintOptionSummary();
    paintCustomerPlan();
    paintApproved();
  }

  /* SOP: four options, every one of them, presented most expensive first.
     Option A's card shows a monthly figure rather than its total, so its
     total comes from the option screen's own adjusted total ($1,089) —
     the design's number, not an invented one. */
  var OPTION_TOTALS = { 'Option A': 1089, 'Option B': 929, 'Option C': 1109 };

  /* A price on its own can't be sold onto a job — the job needs the items.
     The design's option cards already list them, so they are read back out
     of the accepted markup rather than invented alongside it. */
  var OPTION_ITEMS = {};
  function seedOptionItems(screenId) {
    var root = byId(screenId); if (!root) return;
    var cards = $$('div', root).filter(function (e) {
      return /border-radius:12px/.test(e.getAttribute('style') || '') && optionName(e);
    });
    cards = cards.filter(function (e) { return !cards.some(function (o) { return o !== e && o.contains(e); }); });
    cards.forEach(function (c) {
      var name = optionName(c);
      if (!name || OPTION_ITEMS[name]) return;
      var lines = $$('div', c).filter(function (e) { return /font:400 14px/.test(e.getAttribute('style') || ''); });
      var items = lines.map(function (e) {
        var q = $('span', e);
        var nm = norm(e.textContent).replace(/^[0-9]+[ ]*/, '');
        var reg = BY_NAME[nm];
        var base = reg || { sku: '', name: nm, type: 'service', cat: '', price: 0, labor: 0 };
        return {
          sku: base.sku, name: base.name, type: base.type, cat: base.cat,
          price: base.price, labor: base.labor,
          qty: parseInt(norm(q ? q.textContent : '1'), 10) || 1
        };
      });
      if (items.length) OPTION_ITEMS[name] = items;
    });
  }

  // the name is a <span> on the draft screen and a <div> on Ready to present
  function optionName(card) {
    var n = $$('span,div', card).filter(function (e) {
      return !e.children.length && /^Option [A-Z]$/.test(norm(e.textContent));
    })[0];
    return n ? norm(n.textContent) : '';
  }
  function optionTotal(card) {
    var hint = $$('span', card).filter(function (e) { return /^Tap for (total|monthly)$/.test(norm(e.textContent)); })[0];
    var priceEl = $$('span', card).filter(function (e) {
      return /^\$[\d,]+\.\d\d/.test(norm(e.textContent)) && /font:700/.test(e.getAttribute('style') || '');
    })[0];
    // "Tap for total" means the card is currently showing the monthly figure
    if (hint && /Tap for total/.test(norm(hint.textContent))) return OPTION_TOTALS[optionName(card)] || 0;
    return priceEl ? money(priceEl.textContent) : 0;
  }

  function orderOptionsByPrice(screenId) {
    var root = byId(screenId); if (!root) return 0;
    var cards = $$('div', root).filter(function (e) {
      return optionName(e) && /border-radius:12px/.test(e.getAttribute('style') || '');
    });
    // keep only the outermost card per option
    cards = cards.filter(function (e) { return !cards.some(function (o) { return o !== e && o.contains(e); }); });
    if (cards.length < 2) return cards.length;
    var list = cards[0].parentElement;
    cards.slice().sort(function (a, b) { return optionTotal(b) - optionTotal(a); })
      .forEach(function (c) { list.appendChild(c); });
    // anything that isn't an option card (the "add" button) goes back to the end
    $$(':scope > div', list).forEach(function (e) {
      if (!optionName(e)) list.appendChild(e);
    });
    return cards.length;
  }

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
      toggleDisplay(segRow, !shut);
      toggleDisplay(grid, !shut);
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
  var paintOnsiteBar = function () { };
  var jobCard = null, homeCardSlot = null;
  /* Home while no job is on, the in-progress screen while one is. The same
     card either way — moved, never rebuilt. */
  function paintCard() {
    if (!jobCard) return;
    var target = state.onsite ? activeCardSlot : homeCardSlot;
    if (!target || jobCard.nextSibling === target) return;
    target.parentElement.insertBefore(jobCard, target);
  }
  function paintDriveTime(secs) {
    var el = $('[data-drivetime]');
    if (!el) return;
    if (secs === undefined) {
      secs = clock.drive + (clock.mode === 'drive' && clock.since
        ? (Date.now() - clock.since) / 1000 : 0);
    }
    el.textContent = shortClock(secs);
  }
  var paintDash = function () { };

  /* Every job screen carries a Start button in its header, and it kept
     offering to start a job that was already running. Hiding it left a
     gap — and the way to end a job was buried in the kebab, so tapping
     the running-job bar landed you on the job with nothing on screen
     that finished it.

     One slot, the next thing to do: Start before, Complete while it
     runs. Home's own Start sits inside a card rather than a header, and
     Home is not reachable while a job is running, so that one just
     hides. */
  var START_STYLE = '', COMPLETE_STYLE = '';
  function paintStartButtons() {
    $$('.screen [data-act="start"],.screen [data-act="complete"]').forEach(function (b) {
      if (jobHeaderBtns.indexOf(b) > -1) return;
      if (b.dataset.cardbtn) return;        // the card paints its own row
      // Start before the job, Complete during it — one rule, read off
      // whichever the button happens to be
      toggleDisplay(b, b.dataset.act === 'complete' ? !!state.onsite : !state.onsite);
    });
    jobHeaderBtns.forEach(function (b) {
      if (!START_STYLE) START_STYLE = b.getAttribute('style') || '';
      if (!COMPLETE_STYLE) {
        COMPLETE_STYLE = START_STYLE.replace('background:#4A6FA5', 'background:#16A34A');
      }
      if (state.onsite) {
        b.dataset.act = 'complete';
        b.setAttribute('style', COMPLETE_STYLE);
        b.innerHTML = '<span class="mif" style="font-size:18px">task_alt</span>Complete';
      } else {
        b.dataset.act = 'start';
        b.setAttribute('style', START_STYLE);
        b.innerHTML = '<span class="mif" style="font-size:18px">play_arrow</span>Start';
      }
    });
    toggleDisplay(onsiteBar, !!state.onsite);
  }
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

  /* Pressing Start swapped the whole home screen for the in-progress one
     and took the technician's numbers away with it. A job runs for most of
     the day, so that hid the dashboard for most of the day, with no way
     back to it — the Home tab just landed on the same screen again.

     The dashboard is one set of nodes, not two copies: it moves to
     whichever home is on screen. Under the job while one is running,
     back at the top of Home when there isn't. Every KPI reference,
     the period menu and the Week/Month segment keep working because
     nothing is rebuilt. */
  (function () {
    var home = byId('home'), active = byId('home-active');
    if (!home || !active) return;
    var hs = $('.sc', home), as = $('.sc', active);
    // the collapse block above already appended a chevron into this
    // heading, so only its own text nodes still identify it
    var mark = sel(home, '~Overview')[0];
    if (!hs || !as || !mark) { MISS.push('home :: dashboard'); return; }

    // everything above the job heading is the dashboard
    var top = function (el) { while (el && el.parentElement !== hs) el = el.parentElement; return el; };
    var firstBlock = top(mark);
    var blocks = [];
    for (var b = firstBlock; b; b = b.nextElementSibling) {
      if (sel(b, 'Next jobs').length || sel(b, 'Current job').length) break;
      blocks.push(b);
    }
    var home1st = blocks.length ? blocks[blocks.length - 1].nextElementSibling : null;
    if (!blocks.length) { MISS.push('home :: dashboard blocks'); return; }

    paintDash = function () {
      var onJob = !!state.onsite;
      var target = onJob ? as : hs;
      if (blocks[0].parentElement === target) return;
      // same place either way: Home opens on your numbers, with the job
      // under them, running or not. Nothing on screen changes position
      // because a job started.
      var before = onJob ? as.firstElementChild : home1st;
      blocks.forEach(function (el) { target.insertBefore(el, before); });
    };
  })();

  var jobIdx = 0;
  var paintJob = function () { };

  /* A job is live from the moment the tech sets off, not from the moment
     they arrive — that is when the dispatcher, the customer and the clock
     all start treating it as the job in hand. Until then it is just the
     next one on the list. */
  function jobActive() { return !!(state.onsite || state.enroute); }
  function openJobs() {
    var o = [];
    for (var i = 0; i < JOBS.length; i++) if (!JOBS[i].done) o.push(i);
    return o;
  }
  function jobStep(by) {
    if (jobActive()) return;
    var o = openJobs(), at = o.indexOf(jobIdx), to = at + by;
    if (at < 0 || to < 0 || to >= o.length) return;
    jobIdx = o[to];
    loadJob();
    paintJob();
  }

  /* The job's own estimate/invoice stage becomes the session state, so the
     Estimate and Finance tabs open where this job actually is. */
  function loadJob() {
    var j = JOBS[jobIdx];
    state.est = j ? j.est : 'none';
    state.inv = j ? j.inv : 'none';
    renderJobItems();
  }
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

    /* The card said "Next jobs" over one job that could not be left, and the
       pager counted a queue the arrows would not move through.

       Both halves work now, and the heading tells the tech which half they
       are looking at. Nothing live: "Next jobs", with the arrows walking the
       calls still open so the day can be seen before it starts. Live — en
       route or on site: "Current job", and the pager goes, because there is
       nothing to browse while one job is yours. */
    var pager = counter.parentElement;

    /* When the last job was closed the heading said "Nothing left today"
       over the card of the customer the tech had just left — name, address,
       phone and a live En route button for a call that no longer existed.
       An empty day is its own state, so it gets its own card. */
    var card = refs.name.closest('div[style*="border-radius:14px"]');
    var empty = document.createElement('div');
    empty.hidden = true;
    empty.setAttribute('style', 'display:flex;flex-direction:column;align-items:center;gap:9px;' +
      'background:#fff;border:1px solid #DDE3EE;border-radius:14px;padding:30px 22px;text-align:center');
    empty.innerHTML =
      '<span class="mif" style="font-size:32px;color:#16A34A">task_alt</span>' +
      '<div style="font:600 16.5px/1.3 Geist">Every job closed</div>' +
      '<div style="font:400 13.5px/1.5 Geist;color:#546478">' +
      'Nothing else is scheduled for you today. Anything dispatch adds shows up here.</div>' +
      '<div data-tap="1" data-go="timesheet" data-mode="tab" style="margin-top:5px;height:46px;' +
      'display:flex;align-items:center;justify-content:center;gap:7px;padding:0 20px;background:#fff;' +
      'border:1px solid #C8D5E8;color:#4A6FA5;border-radius:10px;font:600 14.5px/1 Geist">' +
      '<span class="mi" style="font-size:19px">schedule</span>See today&rsquo;s hours</div>';
    card.parentElement.insertBefore(empty, card.nextSibling);

    function arrow(el, by) {
      el.dataset.tap = '1';
      el.addEventListener('click', function (ev) { ev.stopPropagation(); jobStep(by); }, true);
    }
    arrow(prev, -1);
    arrow(next, 1);

        paintJob = function () {
      var j = JOBS[jobIdx];
      if (!j) {
        heading.textContent = 'Nothing left today';
        pager.style.display = 'none';
        card.hidden = true;
        empty.hidden = false;
        return;
      }
      card.hidden = false;
      empty.hidden = true;
      var open = openJobs(), at = open.indexOf(jobIdx), live = jobActive();
      heading.textContent = live ? 'Current job' : 'Next jobs';
      pager.style.display = (!live && open.length > 1) ? 'flex' : 'none';
      counter.textContent = (at + 1) + ' of ' + open.length;
      prev.style.color = at > 0 ? '#4A6FA5' : '#A9B4C2';
      next.style.color = at < open.length - 1 ? '#4A6FA5' : '#A9B4C2';
      refs.name.textContent = j.name;
      refs.when.textContent = j.when;
      refs.brief.textContent = j.brief;
      refs.type.textContent = j.type;
      setPhone(refs.phone, j.phone);
      addr.childNodes[0].nodeValue = j.addr;
      awaySpan.textContent = j.away;
    };
  }

  /* The in-progress screen is the same job — it can't keep showing the
     customer from the design mockup once the tech has moved on. */
  /* The in-progress screen has no card of its own any more. What is left
     to keep current is the green bar in the phone's chrome, which names the
     house you are standing in — and goes grey while the job is paused, so
     a stopped clock never looks like a running one.

     It writes the name into the bar's own text node rather than over the
     whole label, which had been quietly deleting the little white dot
     beside it on the first paint. */
  function wireActiveJobCard() {
    var lbl = onsiteBar && onsiteBar.children[0];
    var txt = lbl && [].slice.call(lbl.childNodes).filter(function (n) {
      return n.nodeType === 3 && norm(n.nodeValue);
    })[0];
    if (!txt) { MISS.push('phone :: on-site bar'); return; }
    paintOnsiteBar = function () {
      var j = JOBS[jobIdx];
      txt.nodeValue = (state.paused ? 'Paused · ' : 'On site · ') + (j ? j.name : '');
      onsiteBar.style.background = state.paused ? '#546478' : '#16A34A';
    };
    var prev = paintJob;
    paintJob = function () { prev(); paintOnsiteBar(); };
  }

  /* The order button read "Confirm & order" before anything had been
     signed, and said so only after it was pressed. The board has the
     other label for that state: until the pad is signed this completes
     the presentation, and once it is signed it places the order. */
  var orderBtn = null;
  function paintOrderBtn() {
    if (!orderBtn) return;
    var on = estSigned;
    orderBtn.setAttribute('style', orderBtn.dataset.base +
      (on ? '' : ';background:#EDF0F5;color:#A9B4C2;border-color:#DDE3EE'));
    var icon = $('.mi,.mif', orderBtn);
    if (icon) icon.textContent = on ? 'check_circle' : 'task_alt';
    [].slice.call(orderBtn.childNodes).forEach(function (n) {
      if (n.nodeType === 3 && norm(n.nodeValue)) {
        n.nodeValue = on ? 'Confirm & order' : 'Complete estimate';
      }
    });
  }
  (function () {
    var root = byId('est-customer'); if (!root) return;
    orderBtn = $$('[data-act="estOrder"]', root)[0];
    if (!orderBtn) { MISS.push('est-customer :: order button'); return; }
    orderBtn.dataset.base = orderBtn.getAttribute('style') || '';
    paintOrderBtn();
  })();

  // pick up where the tech left off: which job, each job's stage, and the
  // session flags — before the cards are painted
  jobIdx = recall('jobIdx', 0);
  var savedJobs = recall('jobs', []) || [];
  savedJobs.forEach(function (s, i) {
    if (!JOBS[i] || !s) return;
    JOBS[i].est = s.est; JOBS[i].inv = s.inv; JOBS[i].done = !!s.done;
    if (s.items) JOBS[i].items = s.items;
    if (s.sold !== undefined) JOBS[i].sold = s.sold;
  });
  /* A day is empty when there are no jobs left in it — nothing else.
     Before the queue could be browsed, progress was a cursor and
     everything behind it was finished, so a session saved back then has
     no "done" on it at all. Read the cursor the way it was meant, then
     put it back on a job that is still open: otherwise a tech who
     finished yesterday opened the app to "Nothing left today" over a
     full list of calls. */
  if (!savedJobs.some(function (s) { return s && 'done' in s; })) {
    for (var jd = 0; jd < jobIdx && jd < JOBS.length; jd++) JOBS[jd].done = true;
  }
  if (!JOBS[jobIdx] || JOBS[jobIdx].done) {
    var stillOpen = openJobs();
    jobIdx = stillOpen.length ? stillOpen[0] : JOBS.length;
  }
  loadJob();
  (function () {
    var s = recall('state', null);
    if (s) {
      state.onsite = !!s.onsite; state.enroute = !!s.enroute;
      state.extra = !!s.extra; state.paused = !!s.paused;
    }
  })();
  wireCurrentJob();
  wireActiveJobCard();

  /* The dashboard's period could only be changed from the Timesheet,
     three screens away from the numbers it governs. The control sits with
     them now, at the end of the Week/Month/Quarter/Year row — the four
     shortcuts, then everything else. */
  (function () {
    var root = byId('home'); if (!root) return;
    var week = sel(root, 'Week')[0];
    var strip = week && week.parentElement;
    if (!strip) { MISS.push('home :: period strip'); return; }
    var more = document.createElement('div');
    more.dataset.tap = '1';
    more.dataset.go = 'ov-period';
    more.dataset.mode = 'overlay';
    more.setAttribute('style', 'flex:none;width:38px;display:flex;align-items:center;' +
      'justify-content:center;border-radius:7px;color:#546478');
    more.innerHTML = '<span class="mi" style="font-size:20px">more_vert</span>';
    strip.appendChild(more);
    paintPeriod();
  })();

  /* =========================================================
     The job card, in the order the technician reads it.

     Who and when. What is wrong and whether it is quoted. Where it is
     and the number to ring, side by side instead of a row each. What
     notes exist, said to be notes. What is on file. And last, the three
     things that can be done — with driving there first, because that is
     what happens first; it had been sitting second behind Start.

     Once they are driving, that button becomes the drive clock: a stop
     square and the time, so the running trip is on the card rather than
     only in the Timesheet.

     Everything here is moved, not rebuilt, so every reference the rest
     of the file holds on these nodes stays pointed at the same elements.
     ========================================================= */
  (function () {
    var root = byId('home'); if (!root) return;
    var nameEl = sel(root, 'Randy Johnson')[0];
    var card = nameEl && nameEl.closest('div[style*="border-radius:14px"]');
    if (!card || card.children.length < 3) { MISS.push('home :: job card'); return; }
    var info = card.children[0], chips = card.children[1], actions = card.children[2];
    var nameRow = info.children[0], briefRow = info.children[1];
    var addrRow = info.children[2], phoneRow = info.children[3];
    if (!nameRow || !briefRow || !addrRow || !phoneRow) { MISS.push('home :: card rows'); return; }

    function icon(name, size, colour) {
      var i = document.createElement('span');
      i.className = 'mi';
      i.setAttribute('style', 'font-size:' + size + 'px;color:' + colour + ';flex:none');
      i.textContent = name;
      return i;
    }

    var when = nameRow.children[1];
    if (when) {
      var w = document.createElement('span');
      w.setAttribute('style', 'display:flex;align-items:center;gap:5px;white-space:nowrap');
      nameRow.insertBefore(w, when);
      w.appendChild(icon('schedule', 16, '#8A97A8'));
      w.appendChild(when);
    }

    briefRow.insertBefore(icon('chat', 17, '#8A97A8'), briefRow.firstChild);
    if (briefRow.children[1]) briefRow.children[1].style.flex = '1';

    var pin = $('.mi', addrRow); if (pin) pin.remove();
    var callIcon = $('.mi', phoneRow); if (callIcon) callIcon.remove();
    var phone = phoneRow.firstElementChild;
    var addrText = addrRow.firstElementChild;
    if (addrText) addrText.style.flex = '1';
    addrRow.setAttribute('style', 'display:flex;justify-content:space-between;align-items:flex-start;' +
      'gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid #EDF0F5');
    if (phone) addrRow.appendChild(phone);
    phoneRow.remove();

    // the design lists photos, files, jobs; past work comes first here
    var rest = $$(':scope > span', chips).slice(3);
    var counts = [rest[2], rest[0], rest[1]].filter(Boolean);
    chips.setAttribute('style', 'display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:0 15px 13px');
    var label = document.createElement('span');
    label.setAttribute('style', 'font:500 13px/1 Geist;color:#546478;flex:none');
    label.textContent = 'Notes:';
    chips.insertBefore(label, chips.firstChild);
    // three note chips fit one line once the icons come off, and the words
    // already say what each is
    $$(':scope > span', chips).forEach(function (c) { var i = $('.mi', c); if (i) i.remove(); });

    var shelf = document.createElement('div');
    shelf.setAttribute('style', 'display:flex;gap:7px;padding:11px 15px;' +
      'background:#F8FAFD;border-top:1px solid #EDF0F5');
    counts.forEach(function (c) {
      c.setAttribute('style', (c.getAttribute('style') || '')
        .replace('display:flex', 'display:flex;flex:1;justify-content:center'));
      var ci = $('.mi', c); if (ci) ci.remove();
      shelf.appendChild(c);
    });
    card.insertBefore(shelf, actions);

    // the label is a bare text node beside the icon, not a span of its own
    var start = sel(actions, '~Start')[0];
    var enroute = sel(actions, '~En route')[0];
    // byIcon hands back the glyph; the button is the box around it
    var kebab = (byIcon(actions, 'more_horiz')[0] || {}).parentElement;
    if (!start || !enroute || !kebab) { MISS.push('home :: card actions'); return; }
    var PRIMARY = 'flex:1;height:52px;display:flex;align-items:center;justify-content:center;gap:6px;' +
      'background:#4A6FA5;color:#fff;border-radius:10px;font:600 15px/1 Geist';
    var OUTLINE = 'flex:1;height:52px;display:flex;align-items:center;justify-content:center;gap:6px;' +
      'background:#fff;border:1px solid #C8D5E8;color:#4A6FA5;border-radius:10px;font:600 15px/1 Geist';
    // the amber this app already uses for Driving, everywhere else it appears
    var DRIVING = 'flex:1;height:52px;display:flex;align-items:center;justify-content:center;gap:7px;' +
      'background:#D97706;color:#fff;border-radius:10px;font:600 16px/1 Geist;' +
      'font-variant-numeric:tabular-nums';

    start.setAttribute('style', OUTLINE);
    var si = $('.mi,.mif', start); if (si) si.className = 'mi';

    kebab.setAttribute('style', OUTLINE);
    kebab.textContent = 'Job Details';
    kebab.dataset.go = 'job-general';
    kebab.removeAttribute('data-mode');

    actions.appendChild(enroute);
    actions.appendChild(start);
    actions.appendChild(kebab);

    jobCard = card;
    homeCardSlot = document.createComment('job card');
    card.parentElement.insertBefore(homeCardSlot, card.nextSibling);

    // on site, the green the bar at the top of the screen wears; paused,
    // the slate the bar turns
    var ONSITE = 'flex:1;height:52px;display:flex;align-items:center;justify-content:center;gap:7px;' +
      'background:#16A34A;color:#fff;border-radius:10px;font:600 16px/1 Geist;' +
      'font-variant-numeric:tabular-nums';
    var PAUSED = ONSITE.split('background:#16A34A').join('background:#546478');

    /* Three slots, and they never move or empty out.

       The first is whatever is live: where you are going, how long you have
       been driving, how long you have been here. The second is the state
       change — Start before the visit, Complete during it. The third is
       always Job Details.

       This also replaces the earlier painter, which captured the outlined
       style the first button no longer wears. */
    paintEnroute = function () {
      if (state.onsite) {
        enroute.dataset.act = 'pauseJob';
        enroute.setAttribute('style', state.paused ? PAUSED : ONSITE);
        enroute.innerHTML = '<span class="mif" style="font-size:18px">' +
          (state.paused ? 'play_arrow' : 'pause') + '</span><span data-jobtime>0:00</span>';
      } else if (state.enroute) {
        enroute.dataset.act = 'enroute';
        enroute.setAttribute('style', DRIVING);
        enroute.innerHTML = '<span class="mif" style="font-size:17px">stop_circle</span>' +
          '<span data-drivetime>0:00</span>';
      } else {
        enroute.dataset.act = 'enroute';
        enroute.setAttribute('style', PRIMARY);
        enroute.innerHTML = '<span class="mif" style="font-size:18px">navigation</span>En route';
      }

      start.dataset.cardbtn = '1';
      start.dataset.act = state.onsite ? 'complete' : 'start';
      start.setAttribute('style', OUTLINE);
      // 'Complete' plus an icon is the widest this row ever gets: at 375px
      // the three buttons are 96px each, so the glyph gives back the slack
      start.innerHTML = '<span class="mi" style="font-size:18px">' +
        (state.onsite ? 'task_alt' : 'play_arrow') + '</span>' +
        (state.onsite ? 'Complete' : 'Start');
      toggleDisplay(start, true);

      paintDriveTime();
      paintClock();
    };
    paintEnroute();
  })();

  paintJob();

  /* =========================================================
     US-M12-9 — the unsaved-changes bar shows up only once
     something actually changed
     ========================================================= */
  var RC_SCREENS = ['rc-section', 'rc-furnace', 'rc-condenser', 'rc-refrigerant', 'rc-tech'];
  var saveBars = {};
  function hideSaveBar(id) { toggleDisplay(saveBars[id], false); }
  function showSaveBar(id) { toggleDisplay(saveBars[id], true); }
  RC_SCREENS.forEach(function (id) {
    var root = byId(id); if (!root) return;
    var label = sel(root, 'You made changes to Report Card')[0];
    if (!label) { MISS.push(id + ' :: save bar'); return; }
    var bar = label.parentElement;
    saveBars[id] = bar;
    toggleDisplay(bar, false);
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
      estSigned = true;
      estSignedAt = stamp();
      paintOrderBtn();
      if (when) when.textContent = estSignedAt;
      if (pending) {
        pending.textContent = 'Signed';
        pending.style.background = '#16A34A';
        pending.style.borderColor = '#16A34A';
        pending.style.color = '#fff';
      }
    });
  })();

  // Report Card waiver (49–50) and the technician's own signature (54)
  /* Confirm & order used to fire on an unsigned sheet. The signature is the
     order — without it there is nothing to hold the customer to. */
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

  /* The line saying when the Report Card last changed is the thing you
     reach for when you wonder who changed it — and the only part of it that
     opened anything was the icon at the far end, a 23px target on a line
     the width of the screen. The line is the control. */
  (function () {
    var root = byId('rc-overview'); if (!root) return;
    var stamp = sel(root, 'Latest change: Oct 7, 2025, 9:09 AM (Marek Stroz)')[0];
    var strip = stamp && stamp.parentElement;
    if (!strip) { MISS.push('rc-overview :: latest change'); return; }
    strip.dataset.tap = '1';
    strip.dataset.go = 'rc-changes';
  })();

  /* =========================================================
     The Report Card's key, said in one line.

     Three ratings took three cards and a third of the first screen, and
     said their meaning with a coloured dot — which is the one thing a
     colour-blind technician cannot read, on the control they use most.
     An icon carries the meaning whether or not the colour lands: a tick,
     a warning triangle, an exclamation.

     It stays where the board put it, above the sections and below the
     stamp, with room of its own — three cards was too much furniture for
     a key, but folding it into the stamp line made one crowded block out
     of two separate things.

     This runs before the sections fold, while the only "Good" on this
     screen is still the one in the key.
     ========================================================= */
  (function () {
    var root = byId('rc-overview'); if (!root) return;
    var good = sel(root, 'Good')[0];
    var card = good && good.parentElement;
    var row = card && card.parentElement;
    if (!row || row.children.length !== 3) { MISS.push('rc-overview :: rating key'); return; }

    var KEY = [
      ['check', '#16A34A', 'Good'],
      ['warning', '#D97706', 'Needs Attention'],
      ['error', '#DC2626', 'Needs Immediate Action']
    ];
    $$(':scope > div', row).forEach(function (chip, i) {
      var spec = KEY[i];
      var dot = chip.children[0], label = chip.children[1];
      if (!dot || !label) { MISS.push('rc-overview :: key ' + i); return; }
      chip.setAttribute('style', 'display:flex;align-items:center;gap:6px;flex:none');
      dot.className = 'mif';
      dot.setAttribute('style', 'width:20px;height:20px;border-radius:6px;flex:none;' +
        'display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;' +
        'background:' + spec[1]);
      dot.textContent = spec[0];
      label.setAttribute('style', 'font:500 12.5px/1.2 Geist;color:#546478;white-space:nowrap');
      label.textContent = spec[2];
    });

    row.setAttribute('style', 'display:flex;align-items:center;gap:16px;flex-wrap:wrap;' +
      'row-gap:9px;margin:2px 2px 18px');
  })();

  /* =========================================================
     The Report Card opens where it is.

     Fifty-four items in five sections, and every section was a screen of
     its own: tap in, answer, save, come back out, find your place again.
     That takes the overview away — the three colour counts and the bars
     saying which sections still need attention — exactly while the tech is
     working through them, and the only way to compare two sections is to
     leave one.

     The sections fold open in place instead, each on its own, so two
     half-answered sections can be open at once and the counts above stay
     on screen.

     Nothing is rebuilt: each body is the one the board drew, moved out of
     its screen into a panel under its own card, with its ratings, pickers,
     cameras, switches and signature pads still bound to the same nodes.
     ========================================================= */
  (function () {
    var root = byId('rc-overview'); if (!root) return;
    var SECTIONS = [
      ['Household Analysis', ['rc-section']],
      ['Comfort Analysis', []],
      ['System Analysis', ['rc-furnace', 'rc-condenser', 'rc-refrigerant']],
      ['Customer Section', ['rc-customer']],
      ['Technician Section', ['rc-tech']]
    ];
    var panels = [];

    // it was the scrolling body of a screen; in a panel it is just a block
    function loosen(sc) {
      sc.classList.remove('sc');
      var st = (sc.getAttribute('style') || '')
        .split('flex:1;').join('')
        .split('overflow-y:auto;').join('');
      st = st.split(/padding:[^;]+;?/).join('');
      sc.setAttribute('style', 'padding:13px 0 2px;' + st);
      return sc;
    }

    SECTIONS.forEach(function (spec) {
      var title = sel(root, spec[0])[0];
      var card = title && title.closest('div[style*="border-radius:12px"]');
      if (!card) { MISS.push('rc-overview :: ' + spec[0]); return; }

      var head = title.parentElement;
      if (head === card) {
        /* Customer and Technician are a single flex row with no wrapper, so
           a panel appended to them would land beside the title rather than
           under it. They get a head of their own. */
        var row = document.createElement('div');
        row.setAttribute('style', 'display:flex;align-items:center;gap:10px');
        while (card.firstChild) row.appendChild(card.firstChild);
        card.appendChild(row);
        card.setAttribute('style', (card.getAttribute('style') || '')
          .split(';display:flex;align-items:center;gap:10px').join(''));
        head = row;
      }

      var chev = byIcon(head, 'chevron_right')[0];
      if (!chev) { MISS.push('rc-overview :: ' + spec[0] + ' chevron'); return; }

      // the row opened a screen; now it opens itself
      [card, head, title].forEach(function (e) {
        if (e.dataset.go) { delete e.dataset.go; delete e.dataset.mode; }
      });
      chev.textContent = 'expand_more';

      var panel = document.createElement('div');
      panel.dataset.rcpanel = '1';
      panel.hidden = true;
      panel.setAttribute('style', 'margin-top:12px;border-top:1px solid #EDF0F5');

      var bodies = [];
      spec[1].forEach(function (id, i) {
        var src = byId(id), sc = src && $('.sc', src);
        if (!sc) { MISS.push(spec[0] + ' :: ' + id + ' body'); return; }
        if (i === 0) {
          // System Analysis brings its own three-way control across with it
          var lbl = $('[data-seg]', src);
          var ctl = lbl && lbl.parentElement;
          if (ctl) {
            ctl.setAttribute('style', (ctl.getAttribute('style') || '')
              .split('margin:0 16px 12px;').join('margin:13px 0 0;'));
            panel.appendChild(ctl);
          }
        }
        panel.appendChild(loosen(sc));
        if (i > 0) sc.hidden = true;
        bodies.push(sc);
      });

      if (!bodies.length) {
        var none = document.createElement('div');
        none.setAttribute('style', 'padding:14px 2px 4px;font:400 13.5px/1.5 Geist;color:#8A97A8');
        none.textContent = 'Items 8-19 are not drawn on the design board yet.';
        panel.appendChild(none);
      }

      card.appendChild(panel);
      var me = { card: card, panel: panel, chev: chev };
      panels.push(me);

      if (spec[0] === 'System Analysis') {
        rcSysPick = function (i) {
          bodies.forEach(function (b, k) { b.hidden = k !== i; });
        };
      }

      head.dataset.tap = '1';
      head.addEventListener('click', function (ev) {
        ev.stopPropagation();
        // each section is its own: two half-answered sections open at once is
        // a thing a technician does, and shutting one to see another is how
        // the screens behaved before
        var opening = me.panel.hidden;
        me.panel.hidden = !opening;
        me.chev.textContent = opening ? 'expand_less' : 'expand_more';
        if (opening) {
          setTimeout(function () {
            me.card.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }, 20);
        }
      }, true);
    });

    /* The "You made changes" bar belonged to each section screen. There is
       one screen now, so there is one bar — and only an edit inside an open
       section raises it, not the tap that opened the section. */
    var bar = saveBars['rc-section'];
    if (bar) {
      root.appendChild(bar);
      toggleDisplay(bar, false);
      RC_SCREENS.concat(['rc-overview']).forEach(function (id) { saveBars[id] = bar; });
      root.addEventListener('click', function (ev) {
        var t = ev.target;
        if (bar.contains(t) || !t.closest('[data-rcpanel]')) return;
        if (t.closest('[data-seg]') || t.closest('.mi, .mif') || t.dataset.tap) {
          showSaveBar('rc-overview');
        }
      }, true);
    }
  })();

  /* =========================================================
     A customer saying no is a state the app has to hold. Without it the
     estimate is stuck "ready to present" forever and the tech has to
     rebuild the call when they change their mind on the doorstep.
     ========================================================= */
  (function () {
    var root = byId('est-customer'); if (!root) return;
    // the order button's icon changes with the signature, so it is found
    // by what it does rather than by the glyph it is wearing
    var confirm = $('[data-act="estOrder"]', root);
    var footer = confirm && confirm.parentElement;
    if (!footer) { MISS.push('est-customer :: footer'); return; }

    var decline = document.createElement('div');
    decline.setAttribute('data-act', 'estDecline');
    decline.dataset.tap = '1';
    decline.setAttribute('style',
      'padding:11px 16px 2px;text-align:center;font:600 14px/1 Geist;color:#8A97A8;background:#fff;flex:none');
    decline.textContent = 'Customer declined';
    footer.parentElement.insertBefore(decline, footer);
  })();

  /* =========================================================
     A customer who is thinking about it.

     The board puts a follow-up date on the screen the estimate is
     presented from, and it was not built. Without it "they'll think about
     it" is a conversation nobody wrote down — the tech drives away and
     the estimate goes quiet.

     Four answers, because a technician standing at a door picks a rough
     day and not a calendar square, and the date each one means is shown
     so it is a date and not a phrase.
     ========================================================= */
  var FOLLOW_UP = [['Tomorrow', 1], ['In three days', 3], ['Next week', 7],
    ['In two weeks', 14], ['No follow-up', -1]];
  var followUpDays = -1;
  var followField = null;

  function followDate(days) {
    if (days < 0) return 'Not set';
    var d = new Date();
    d.setDate(d.getDate() + days);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return M[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function paintFollowUp() {
    if (followField) followField.textContent = followDate(followUpDays);
    $$('[data-follow]').forEach(function (r) {
      var on = +r.dataset.follow === followUpDays;
      r.style.background = on ? '#F2F5F9' : '';
      $('.mi,.mif', r).style.visibility = on ? 'visible' : 'hidden';
    });
  }

  (function () {
    var list = byId('followList'); if (!list) return;
    FOLLOW_UP.forEach(function (spec) {
      var r = document.createElement('div');
      r.dataset.tap = '1';
      r.dataset.follow = String(spec[1]);
      r.setAttribute('style', 'display:flex;align-items:center;gap:12px;padding:15px 18px;' +
        'font:500 15.5px/1.2 Geist;border-bottom:1px solid #EDF0F5');
      r.innerHTML = '<span class="mif" style="font-size:20px;color:#4A6FA5;width:22px">check</span>' +
        '<span style="flex:1"></span><span data-when style="font:400 13px/1 Geist;color:#8A97A8"></span>';
      r.children[1].textContent = spec[0];
      $('[data-when]', r).textContent = spec[1] < 0 ? '' : followDate(spec[1]);
      list.appendChild(r);
    });
    list.addEventListener('click', function (ev) {
      var r = ev.target.closest('[data-follow]'); if (!r) return;
      ev.stopPropagation();
      followUpDays = +r.dataset.follow;
      remember('followUpDays', followUpDays);
      closeOverlays(false);
      paintFollowUp();
      toast(followUpDays < 0 ? 'No follow-up set'
        : 'Follow up on ' + followDate(followUpDays), 'event');
    }, true);
  })();

  /* =========================================================
     What the customer is shown, and what the signature records.

     Three screens carried the mock-up's answers instead of the job's.

     The customer's own summary quoted Ally at 12 months whatever the
     technician had picked on the draft — different finance terms on the
     screen being signed from the ones that were chosen a tap earlier.

     Its "special notes" box was a div. The one place the customer gets to
     put something in their own words could not be typed into, and nothing
     carried it anywhere.

     And Approved was the mock-up end to end: Option C, its four items and
     $1,109.00, signed by Randy Johnson at 9:09 AM on a date in 2025 —
     whichever option the customer actually chose and whenever they
     actually signed. That screen is the record of the sale.
     ========================================================= */
  var specialNote = '';
  var custPlanRefs = null;
  var approvedRefs = null;

  function planLine() {
    var p = plan();
    return p.months ? p.name + ' — ' + p.rate.toFixed(2) + '% / ' + p.months + ' mo' : p.name;
  }
  function planTerms(withInterest) {
    var p = plan();
    if (!p.months) return 'Paid in full — no financing';
    return 'Monthly factor ' + (planFactor() * 100).toFixed(2) + '%' +
      (withInterest ? ' · Interest ' + p.rate.toFixed(2) + '%' : '') +
      ' · APR ' + p.apr.toFixed(2) + '% · ' + p.months + ' months';
  }

  function paintCustomerPlan() {
    if (!custPlanRefs) return;
    custPlanRefs.name.textContent = planLine();
    custPlanRefs.terms.textContent = planTerms(false);
  }

  function paintApproved() {
    var R = approvedRefs; if (!R) return;
    var pick = pickedOption;
    R.name.textContent = pick;

    var items = OPTION_ITEMS[pick] || [];
    R.items.innerHTML = '';
    items.forEach(function (it) {
      // the row is a quantity in a span and the name as the row's own text
      var row = R.itemTpl.cloneNode(true);
      var q = $('span', row);
      if (q) q.textContent = String(it.qty);
      var txt = [].slice.call(row.childNodes).filter(function (n) {
        return n.nodeType === 3 && norm(n.nodeValue);
      })[0];
      if (txt) txt.nodeValue = ' ' + it.name;
      else row.appendChild(document.createTextNode(' ' + it.name));
      R.items.appendChild(row);
    });
    R.total.textContent = fmt(OPTION_TOTALS[pick] || 0);

    var when = estSignedAt || stamp();
    R.stamp.textContent = when;
    var j = typeof JOBS !== 'undefined' ? JOBS[jobIdx] : null;
    R.sig.textContent = (j ? j.name : 'Customer') + ' · ' + when;
    R.rej.textContent = String(Math.max(0, optCount - 1));
    R.planName.textContent = planLine();
    R.planTerms.textContent = planTerms(true);

    // the customer's own words, where they were written, on the record
    R.note.hidden = !specialNote;
    if (specialNote) R.noteText.textContent = specialNote;
  }

  (function () {
    var root = byId('est-customer'); if (!root) return;
    var sc = $$('.sc', root).pop(); if (!sc) { MISS.push('est-customer :: body'); return; }

    var lbl = sel(root, 'Plan')[0];
    var row = lbl && lbl.parentElement;
    if (row && row.children.length >= 3) custPlanRefs = { name: row.children[1], terms: row.children[2] };
    else MISS.push('est-customer :: plan row');

    var box = $$(':scope > div', sc).filter(function (e) {
      return norm(e.textContent) === 'Write additional special notes';
    })[0];
    if (!box) { MISS.push('est-customer :: special notes'); return; }

    // the date sits with the note, above the signature it may replace
    var fu = document.createElement('div');
    fu.dataset.tap = '1';
    fu.dataset.go = 'ov-followup';
    fu.dataset.mode = 'overlay';
    fu.setAttribute('style', 'display:flex;align-items:center;gap:12px;background:#fff;' +
      'border:1px solid #DDE3EE;border-radius:11px;padding:12px 14px;margin-top:12px');
    fu.innerHTML = '<span class="mi" style="font-size:20px;color:#4A6FA5">event</span>' +
      '<div style="flex:1"><div style="font:500 12.5px/1 Geist;color:#546478">Follow-up date</div>' +
      '<div data-followval style="font:500 15.5px/1.2 Geist;margin-top:6px"></div></div>' +
      '<span class="mi" style="font-size:21px;color:#A9B4C2">chevron_right</span>';
    box.parentElement.insertBefore(fu, box.nextSibling);
    followField = $('[data-followval]', fu);
    followUpDays = recall('followUpDays', -1);
    paintFollowUp();
    var ta = document.createElement('textarea');
    ta.className = 'inp';
    ta.placeholder = 'Write additional special notes';
    ta.setAttribute('style', 'width:100%;height:80px;resize:none;padding:13px 14px;' +
      'background:#fff;border:1px solid #DDE3EE;border-radius:11px;font:400 14.5px/1.5 Geist');
    box.parentElement.replaceChild(ta, box);
    ta.addEventListener('input', function () { specialNote = ta.value; });
  })();

  (function () {
    var root = byId('est-approved'); if (!root) return;
    var sc = $$('.sc', root).pop(); if (!sc) { MISS.push('est-approved :: body'); return; }
    var card = sc.children[1], sig = sc.children[2], rej = sc.children[3], pl = sc.children[4];
    var stampEl = sel(root, 'Oct 7, 2025, 9:09 AM')[0];
    var head = card && card.children[0];
    var items = card && card.children[1];
    var totalRow = card && card.children[2];
    if (!stampEl || !head || !items || !items.children.length || !totalRow ||
      !sig || sig.children.length < 3 || !rej || rej.children.length < 2 ||
      !pl || pl.children.length < 3) {
      MISS.push('est-approved :: record'); return;
    }

    var note = document.createElement('div');
    note.hidden = true;
    note.setAttribute('style', 'background:#fff;border:1px solid #DDE3EE;border-radius:12px;' +
      'padding:14px;margin-bottom:12px');
    note.innerHTML =
      '<div style="font:600 12px/1 Geist;letter-spacing:.07em;color:#8A97A8;' +
      'text-transform:uppercase;margin-bottom:8px">Customer&rsquo;s note</div>' +
      '<div data-note style="font:400 14.5px/1.5 Geist;color:#1A2332"></div>';
    sc.insertBefore(note, rej);

    approvedRefs = {
      stamp: stampEl,
      name: head.children[1],
      items: items,
      itemTpl: items.children[0].cloneNode(true),
      total: totalRow.children[1],
      sig: sig.children[2],
      rej: rej.children[1],
      planName: pl.children[1],
      planTerms: pl.children[2],
      note: note,
      noteText: $('[data-note]', note)
    };
    paintApproved();
    paintCustomerPlan();
  })();

  /* A paid invoice is not the end of the job — the customer can add work,
     or the first invoice can be wrong. US-M11-5. */
  (function () {
    var root = byId('inv-paid'); if (!root) return;
    var sc = $('.sc', root); if (!sc) { MISS.push('inv-paid :: body'); return; }
    var btn = document.createElement('div');
    btn.setAttribute('data-act', 'reinvoice');
    btn.dataset.tap = '1';
    btn.setAttribute('style',
      'display:flex;align-items:center;justify-content:center;gap:9px;background:#fff;' +
      'border:1px dashed #C8D5E8;border-radius:12px;padding:15px;margin-top:12px;' +
      'font:600 14.5px/1 Geist;color:#4A6FA5');
    btn.innerHTML = '<span class="mi" style="font-size:19px">note_add</span>New invoice for this job';
    sc.appendChild(btn);
  })();

  /* A declined estimate stays presentable — that is the whole point. */
  var declinedOnce = false;
  function markDeclined() {
    declinedOnce = true;
    remember('declined', true);
    var root = byId('est-ready'); if (!root) return;
    if (byId('declinedNote')) return;
    var list = sel(root, 'Options list')[0];
    if (!list) return;
    var note = document.createElement('div');
    note.id = 'declinedNote';
    note.setAttribute('style',
      'display:flex;align-items:flex-start;gap:9px;background:#FEF3E2;border:1px solid #F3D9AE;' +
      'border-radius:11px;padding:12px 13px;margin-bottom:12px');
    note.innerHTML = '<span class="mi" style="font-size:19px;color:#D97706;margin-top:1px">history_toggle_off</span>' +
      '<div style="font:400 13px/1.45 Geist;color:#7A5B12">Declined earlier &mdash; still open to present again.</div>';
    list.parentElement.insertBefore(note, list);
  }

  /* =========================================================
     US-W11-1 / W-11 (decision) — four options, and the same four
     everywhere. The mockup's "3/6" was the outlier: FR-5.12 says up to 4
     and the SOP presents exactly 4.
     ========================================================= */
  var MAX_OPTIONS = 4;
  var optCount = 3;              // the accepted draft ships with A, B and C
  // declared before the block that calls paintOptions(), or they'd still be
  // undefined on the first paint and blow the button's styling away
  var optSendBtn = null;
  var SEND_ON = 'height:52px;display:flex;align-items:center;justify-content:center;gap:8px;' +
    'background:#4A6FA5;color:#fff;border-radius:11px;font:600 16px/1 Geist';
  var optList = null, optAddBtn = null, optCard = null, optFooters = [];
  (function () {
    var root = byId('est-draft'); if (!root) return;
    var a = sel(root, 'Option A')[0];
    optCard = a && a.closest('div[style*="border-radius"]');
    optList = optCard && optCard.parentElement;
    optAddBtn = sel(root, '@add^1')[0];
    optSendBtn = sel(root, '@send^1')[0];
    // the counter is repeated on draft / in review / ready to present
    ['est-draft', 'est-review', 'est-ready'].forEach(function (id) {
      var f = sel(byId(id), 'Options: 3/6')[0];
      if (f) optFooters.push(f); else MISS.push(id + ' :: options counter');
    });
    if (!optCard || !optList || !optFooters.length) { MISS.push('est-draft :: options'); return; }
    ['est-ready', 'est-draft', 'est-review'].forEach(seedOptionItems);
    // rebuild the options the tech added before the reload
    addedOptions.slice().forEach(function (o) { addOption(o.total, o.items, true); });
    paintOptions();

    // the empty state quotes the limit too
    var empty = sel(byId('est-empty'), 'Start by adding a new option. You can create up to 6 options for this job.')[0];
    if (empty) empty.textContent = 'Start by adding a new option. You can create up to ' +
      MAX_OPTIONS + ' options for this job.';
  })();

  function paintOptions() {
    var short = MAX_OPTIONS - optCount;
    optFooters.forEach(function (f) { f.textContent = 'Options: ' + optCount + '/' + MAX_OPTIONS; });
    if (optAddBtn) optAddBtn.style.opacity = optCount >= MAX_OPTIONS ? '.45' : '';
    paintNextStep();
    ['est-draft', 'est-review', 'est-ready'].forEach(orderOptionsByPrice);
    paintPriceRange();
    paintPlanEverywhere();
  }

  /* The draft used to show one greyed-out "Send to review" that refused to
     work until a fourth option existed, with the only way to build one
     buried under three full-height option cards. Both halves were wrong:
     the send was dead, and adding an option was hidden.

     They are two different things, so they are two buttons, side by side
     and both live. Four options is the ceiling, not a quota — an estimate
     with two goes to review just the same. The dashed button in the list
     still works for anyone who scrolls that far. */
  var optAddSecondary = null;
  function paintNextStep() {
    if (!optSendBtn) return;
    if (!optAddSecondary) {
      var row = document.createElement('div');
      row.setAttribute('style', 'display:flex;gap:9px;align-items:stretch');
      optSendBtn.parentElement.insertBefore(row, optSendBtn);
      optAddSecondary = document.createElement('div');
      optAddSecondary.dataset.tap = '1';
      optAddSecondary.dataset.act = 'newOption';
      row.appendChild(optAddSecondary);
      optSendBtn.style.flex = '1.5';
      row.appendChild(optSendBtn);
    }
    var room = optCount < MAX_OPTIONS;
    optAddSecondary.setAttribute('style',
      'flex:1;height:54px;display:flex;align-items:center;justify-content:center;gap:6px;' +
      'background:#fff;border:1px solid #C8D5E8;border-radius:11px;font:600 15px/1 Geist;' +
      'color:#4A6FA5' + (room ? '' : ';opacity:.45'));
    optAddSecondary.innerHTML = '<span class="mi" style="font-size:19px">add</span>Add option';
    optSendBtn.setAttribute('style', SEND_ON);
    optSendBtn.style.flex = '1.5';
    optSendBtn.innerHTML = '<span class="mi" style="font-size:20px">send</span>Send to review';
    optSendBtn.dataset.act = 'estSendReview';
  }

  /* The footer range has to move when an option is added, or it quietly
     misreports what the customer is being shown. */
  function paintPriceRange() {
    var live = Object.keys(OPTION_TOTALS)
      .slice(0, optCount)
      .map(function (k) { return OPTION_TOTALS[k]; })
      .filter(function (v) { return v > 0; });
    if (!live.length) return;
    var lo = Math.min.apply(null, live), hi = Math.max.apply(null, live);
    ['est-draft', 'est-review', 'est-ready'].forEach(function (id) {
      var root = byId(id); if (!root) return;
      $$('span', root).forEach(function (e) {
        if (/^\$[\d,]+\.\d\d\s*–\s*\$[\d,]+\.\d\d$/.test(norm(e.textContent))) {
          e.textContent = fmt(lo) + ' – ' + fmt(hi);
        }
      });
    });
  }

  function addOption(total, items, replay) {
    if (!optCard || !optList) return false;
    if (optCount >= MAX_OPTIONS) return false;
    var copy = optCard.cloneNode(true);
    // the next free letter, not the next number: an option can be deleted
    var taken = {};
    $$(':scope > div', optList).forEach(function (c) {
      var n = optionName(c); if (n) taken[n] = 1;
    });
    var name = '';
    for (var li = 0; li < 26 && !name; li++) {
      var cand = 'Option ' + String.fromCharCode(65 + li);
      if (!taken[cand]) name = cand;
    }
    var title = $$('span', copy).filter(function (e) { return /^Option [A-Z]$/.test(norm(e.textContent)); })[0];
    if (title) title.textContent = name;

    // the clone arrives with Option A's line items — swap in the real ones
    if (items && items.length) {
      var rows = $$('div', copy).filter(function (e) {
        return /^\d+$/.test(norm($('span', e) ? $('span', e).textContent : '')) &&
          /font:400 14px/.test(e.getAttribute('style') || '');
      });
      var box = rows.length ? rows[0].parentElement : null;
      if (box) {
        box.innerHTML = '';
        items.forEach(function (it) {
          var row = document.createElement('div');
          row.setAttribute('style', 'display:flex;gap:10px;font:400 14px/1.3 Geist');
          row.innerHTML = '<span style="font-weight:600;color:#8A97A8;min-width:16px"></span>';
          row.firstChild.textContent = String(it.qty);
          row.appendChild(document.createTextNode(it.name));
          box.appendChild(row);
        });
      }
    }

    // the new option carries the total the tech actually built
    if (items && items.length) OPTION_ITEMS[name] = items;
    if (total) {
      OPTION_TOTALS[name] = total;
      var priceEl = $$('span', copy).filter(function (e) {
        return /^\$[\d,]+\.\d\d/.test(norm(e.textContent)) && /font:700/.test(e.getAttribute('style') || '');
      })[0];
      var hint = $$('span', copy).filter(function (e) { return /^Tap for (total|monthly)$/.test(norm(e.textContent)); })[0];
      if (priceEl) { priceEl.textContent = fmt(total); }
      if (hint) hint.textContent = 'Tap for monthly';
    }
    optList.insertBefore(copy, optAddBtn && optAddBtn.parentElement === optList ? optAddBtn : null);
    if (!replay) {
      addedOptions.push({ name: name, total: total, items: items || [] });
      remember('addedOptions', addedOptions);
    }
    optCount++;
    paintOptions();
    return true;
  }

  /* =========================================================
     The option menu, which only ever edited.

     Eight rows, and seven of them closed the sheet and did nothing:
     duplicate, the note and description toggles, email, SMS, print
     preview and delete. On the screen where a technician builds the thing
     the customer signs.

     They work on the option the menu was opened from — which the sheet
     did not know either, so it said "Option A" over whichever card you
     had tapped.
     ========================================================= */
  var menuCard = null;
  var optionNotes = { 'Option B': 'Includes the duct work the attic needs before the new unit goes in.' };
  var showDesc = {};
  var showNote = {};

  function cardItems(card) {
    var n = optionName(card);
    return (OPTION_ITEMS[n] || []).slice();
  }
  function cardItemsBox(card) { return card.children[1]; }

  /* The item lines on a card are a quantity and a name. The descriptions
     live in the catalog, so they are looked up rather than stored twice. */
  function descOf(name) {
    var row = CATALOG_ROWS.filter(function (r) { return r[0] === name; })[0];
    return row ? row[1] : '';
  }

  function paintCardExtras(card) {
    var n = optionName(card); if (!n) return;
    var box = cardItemsBox(card); if (!box) return;

    $$('[data-optdesc]', box).forEach(function (e) { e.remove(); });
    if (showDesc[n]) {
      $$(':scope > div', box).forEach(function (line) {
        if (line.dataset.optdesc) return;
        var nm = norm(line.textContent).replace(/^[0-9]+[ ]*/, '');
        var d = descOf(nm); if (!d) return;
        var el = document.createElement('div');
        el.dataset.optdesc = '1';
        el.setAttribute('style', 'font:400 12.5px/1.45 Geist;color:#8A97A8;margin:-2px 0 2px 26px');
        el.textContent = d;
        box.insertBefore(el, line.nextSibling);
      });
    }

    var note = $('[data-optnote]', card);
    if (optionNotes[n] && showNote[n] !== false) {
      if (!note) {
        note = document.createElement('div');
        note.dataset.optnote = '1';
        note.setAttribute('style', 'margin:0 14px 12px;padding:10px 12px;background:#F5F7FA;' +
          'border:1px solid #DDE3EE;border-radius:9px;font:400 12.5px/1.45 Geist;color:#546478');
        card.insertBefore(note, card.lastElementChild);
      }
      note.textContent = optionNotes[n];
      note.hidden = false;
    } else if (note) {
      note.hidden = true;
    }
  }

  function paintAllCards() {
    ['est-draft', 'est-review', 'est-ready'].forEach(function (id) {
      var root = byId(id); if (!root) return;
      var cards = $$('div', root).filter(function (e) {
        return /border-radius:12px/.test(e.getAttribute('style') || '') && optionName(e);
      });
      cards = cards.filter(function (e) { return !cards.some(function (o) { return o !== e && o.contains(e); }); });
      cards.forEach(paintCardExtras);
    });
  }

  (function () {
    // the kebab says which card it belongs to
    ['est-draft', 'est-review', 'est-ready'].forEach(function (id) {
      var root = byId(id); if (!root) return;
      $$('[data-go="ov-option-menu"]', root).forEach(function (k) {
        k.addEventListener('click', function () {
          menuCard = k.closest('div[style*="border-radius:12px"]');
          var title = byId('optMenuName');
          var n = menuCard && optionName(menuCard);
          if (title && n) title.textContent = n;
          var noteRow = byId('optMenuNote'), descRow = byId('optMenuDesc');
          // the label is the row's own text, next to the icon element
          function relabel(row, text) {
            if (!row) return;
            var t = [].slice.call(row.childNodes).filter(function (x) {
              return x.nodeType === 3 && norm(x.nodeValue);
            })[0];
            if (t) t.nodeValue = text;
          }
          relabel(noteRow, showNote[n] === false ? 'Show note' : 'Hide note');
          if (noteRow) toggleDisplay(noteRow, !!optionNotes[n]);
          relabel(descRow, showDesc[n] ? 'Hide description' : 'Show description');
        }, true);
      });
    });

    var menu = byId('ov-option-menu'); if (!menu) return;
    var title = sel(menu, 'Option A')[0];
    if (title) title.id = 'optMenuName';
    // each row is an icon and a bare label, so the row itself is what owns
    // the text — there is no element whose whole text is "Duplicate option"
    function row(label) { return sel(menu, '~' + label)[0] || null; }
    var rows = {
      dup: row('Duplicate option'), note: row('Hide note'), desc: row('Show description'),
      mail: row('Send by email'), sms: row('Send by SMS'),
      print: row('Print preview'), del: row('Delete option')
    };
    /* The board offers a preview and a print; only the preview came across.
       A technician with a van printer wants the paper, not a picture of it. */
    if (rows.print) {
      var paper = rows.print.cloneNode(true);
      paper.dataset.act = 'optMenuPaper';
      paper.removeAttribute('data-go');
      var icon = $('.mi,.mif', paper); if (icon) icon.textContent = 'print';
      [].slice.call(paper.childNodes).forEach(function (n) {
        if (n.nodeType === 3 && norm(n.nodeValue)) n.nodeValue = 'Print';
      });
      rows.print.parentElement.insertBefore(paper, rows.print.nextSibling);
    }
    if (rows.note) rows.note.id = 'optMenuNote';
    if (rows.desc) rows.desc.id = 'optMenuDesc';
    Object.keys(rows).forEach(function (k) {
      if (!rows[k]) { MISS.push('ov-option-menu :: ' + k); return; }
      rows[k].dataset.act = 'optMenu' + k.charAt(0).toUpperCase() + k.slice(1);
      rows[k].removeAttribute('data-go');
    });
  })();

  function menuName() { return menuCard ? optionName(menuCard) : ''; }

  ACT.optMenuDup = function () {
    var n = menuName();
    closeOverlays(true);
    if (!n) return;
    if (!addOption(OPTION_TOTALS[n] || 0, cardItems(menuCard))) {
      toast('Maximum ' + MAX_OPTIONS + ' options per job', 'block');
      return;
    }
    paintAllCards();
    toast(n + ' copied — edit the copy to make it different', 'content_copy');
  };
  ACT.optMenuNote = function () {
    var n = menuName();
    closeOverlays(true);
    if (!n) return;
    showNote[n] = showNote[n] === false;
    paintAllCards();
    toast(showNote[n] === false ? 'Note hidden from the card' : 'Note shown on the card', 'sticky_note_2');
  };
  ACT.optMenuDesc = function () {
    var n = menuName();
    closeOverlays(true);
    if (!n) return;
    showDesc[n] = !showDesc[n];
    paintAllCards();
    toast(showDesc[n] ? 'Item descriptions shown' : 'Item descriptions hidden', 'subject');
  };
  ACT.optMenuMail = function () {
    var n = menuName();
    closeOverlays(true);
    queued('Estimate');
    toast(net.online ? n + ' emailed to the customer' : n + ' will be emailed when there is signal', 'mail');
  };
  ACT.optMenuSms = function () {
    var n = menuName();
    closeOverlays(true);
    queued('Estimate');
    toast(net.online ? n + ' sent by SMS' : n + ' will be sent by SMS when there is signal', 'sms');
  };
  ACT.optMenuPrint = function () {
    closeOverlays(true);
    go('est-preview', 'modal');
  };
  ACT.optMenuPaper = function () {
    var n = menuName();
    closeOverlays(true);
    queued('Estimate');
    toast(net.online ? n + ' sent to the printer' : n + ' will print when there is signal', 'print');
  };
  ACT.optMenuDel = function () {
    var n = menuName(), card = menuCard;
    closeOverlays(true);
    if (!card || !n) return;
    if (optCount <= 1) { toast('An estimate needs at least one option', 'block'); return; }
    card.remove();
    delete OPTION_TOTALS[n];
    delete OPTION_ITEMS[n];
    addedOptions = addedOptions.filter(function (o) { return o.name !== n; });
    remember('addedOptions', addedOptions);
    optCount = Math.max(0, optCount - 1);
    if (pickedOption === n) pickedOption = optionName($$(':scope > div', optList)[0]) || 'Option A';
    paintOptions();
    paintPlanEverywhere();
    toast(n + ' deleted', 'delete_outline');
  };

  /* what the customer turned down, on the record that says how many */
  (function () {
    var root = byId('est-approved'); if (!root) return;
    var rej = sel(root, 'Rejected options')[0];
    var row = rej && rej.parentElement;
    if (!row) { MISS.push('est-approved :: rejected row'); return; }
    row.dataset.tap = '1';
    row.dataset.go = 'ov-rejected';
    row.dataset.mode = 'overlay';
    row.addEventListener('click', function () {
      var list = byId('rejectedList'); if (!list) return;
      list.innerHTML = '';
      Object.keys(OPTION_TOTALS).filter(function (n) { return n !== pickedOption; })
        .forEach(function (n) {
          var card = document.createElement('div');
          card.setAttribute('style', 'background:#fff;border:1px solid #DDE3EE;border-radius:12px;' +
            'padding:13px 14px;margin-bottom:9px');
          card.innerHTML = '<div style="display:flex;align-items:baseline;gap:10px">' +
            '<span data-n style="flex:1;font:600 15.5px/1.2 Geist"></span>' +
            '<span data-t style="font:600 15px/1 Geist;color:#546478"></span></div>' +
            '<div data-i style="margin-top:9px;font:400 13px/1.6 Geist;color:#8A97A8"></div>';
          $('[data-n]', card).textContent = n;
          $('[data-t]', card).textContent = fmt(OPTION_TOTALS[n] || 0);
          $('[data-i]', card).textContent = (OPTION_ITEMS[n] || [])
            .map(function (it) { return it.qty + ' × ' + it.name; }).join(' · ');
          list.appendChild(card);
        });
      if (!list.children.length) {
        list.innerHTML = '<div style="padding:24px 4px;text-align:center;font:400 14px/1.5 Geist;' +
          'color:#8A97A8">This estimate had only the one option.</div>';
      }
    }, true);
  })();

  /* =========================================================
     US-M05-1 — "Add note" actually adds one, stamped with the author
     and the time, into the same card the sheet already uses.
     ========================================================= */
  function noteStamp() {
    var d = new Date();
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var h = d.getHours() % 12 || 12;
    return m[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' – ' +
      h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (d.getHours() < 12 ? 'AM' : 'PM');
  }

  /* =========================================================
     Notes: three kinds, one store.

     A technician writing a note has to know who ends up reading it. The
     detailed description and the technician's notes travel with the job
     to the customer; private notes never leave the company, which is the
     whole reason the kind exists — "customer has a small baby, do not
     ring the doorbell" is not for the customer to read back. Every list
     now says which it is, in words, above the notes themselves.

     The office writes the detailed description, so it stays read-only
     here. The two the technician writes, the technician can fix and
     remove — a note typed on a phone in a plant room is going to have
     mistakes in it, and there was no way to correct one.

     One store behind three surfaces: the Notes tab's segment and the two
     dialogs off Home show the same notes, so an edit in either shows in
     both.
     ========================================================= */
  var NOTE_KINDS = {
    detailed: {
      seg: 'Detailed', title: 'Detailed description',
      shared: true, readOnly: true, add: ''
    },
    tech: {
      seg: "Technician's", title: "Technician's Notes",
      shared: true, readOnly: false, add: "Add technician's note"
    },
    private: {
      seg: 'Private', title: 'Private Notes',
      shared: false, readOnly: false, add: 'Add private note'
    }
  };
  var NOTE_ORDER = ['detailed', 'tech', 'private'];

  /* the design's own cards are the starting content — read once, then the
     store is what every surface draws from */
  var noteCard = null;
  function noteListBox(screenId) {
    var root = byId(screenId); if (!root) return null;
    var any = $$('div', root).filter(function (e) {
      // the dialogs draw the card at 11px, the sheet the tab came from at 12px
      var st = e.getAttribute('style') || '';
      return /border-radius:1[12]px/.test(st) && /background:#F5F7FA/.test(st);
    })[0];
    return any ? any.parentElement : null;
  }
  function noteSeed(screenId) {
    var box = noteListBox(screenId);
    if (!box) { MISS.push(screenId + ' :: note cards'); return []; }
    if (!noteCard) noteCard = box.firstElementChild.cloneNode(true);
    return $$(':scope > div', box).map(function (c) {
      var meta = $$('span', c);
      return {
        text: norm(c.firstElementChild.textContent),
        stamp: meta[0] ? norm(meta[0].textContent) : '',
        author: meta[1] ? norm(meta[1].textContent) : ''
      };
    });
  }

  var notes = recall('notes.v2', null);
  if (!notes) {
    notes = {
      detailed: noteSeed('ov-note-detailed'),
      tech: noteSeed('ov-note-tech'),
      private: noteSeed('ov-note-private')
    };
    remember('notes.v2', notes);
  } else {
    noteSeed('ov-note-detailed');          // still need the card template
  }
  function saveNotes() { remember('notes.v2', notes); }

  function noteStampNow() { return noteStamp(); }

  /* ---- one surface: a list box, an optional add button, a banner ---- */
  var noteSurfaces = [];

  function noteBanner(kind) {
    var k = NOTE_KINDS[kind];
    var el = document.createElement('div');
    el.setAttribute('data-notebanner', '1');
    var on = k.shared;
    el.setAttribute('style', 'display:flex;align-items:center;gap:8px;margin:0 16px 12px;' +
      'padding:10px 12px;border-radius:10px;font:500 12.5px/1.35 Geist;' +
      (on ? 'background:#E8F6ED;border:1px solid #B6E3C6;color:#15803D'
          : 'background:#FEF3E2;border:1px solid #F3D9AE;color:#8A6114'));
    el.innerHTML = '<span class="mi" style="font-size:18px;flex:none"></span><span></span>';
    el.children[0].textContent = on ? 'visibility' : 'lock';
    el.children[1].textContent = on
      ? 'The customer sees these notes'
      : 'Internal only — the customer never sees these';
    return el;
  }

  function noteRow(kind, rec, idx) {
    var k = NOTE_KINDS[kind];
    var card = noteCard.cloneNode(true);
    card.setAttribute('data-note', '1');
    var body = card.firstElementChild;
    var meta = card.children[1];
    body.textContent = rec.text;

    // date and author move together so the actions get the right-hand side
    meta.innerHTML = '<span></span>';
    meta.firstElementChild.textContent = rec.stamp + (rec.author ? ' · ' + rec.author : '');
    meta.setAttribute('style', 'display:flex;justify-content:space-between;align-items:center;' +
      'gap:10px;margin-top:11px;font:500 12.5px/1 Geist;color:#8A97A8');

    if (k.readOnly) return card;

    var acts = document.createElement('div');
    acts.setAttribute('style', 'display:flex;gap:2px;flex:none;margin:-8px -6px -8px 0');
    [['edit', 'Edit'], ['delete_outline', 'Delete']].forEach(function (a) {
      var b = document.createElement('span');
      b.className = 'mi';
      b.dataset.tap = '1';
      b.dataset.noteact = a[0];
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', a[1] + ' note');
      b.setAttribute('style', 'font-size:19px;color:#8A97A8;padding:8px;border-radius:8px');
      b.textContent = a[0];
      acts.appendChild(b);
    });
    meta.appendChild(acts);

    acts.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var hit = ev.target.closest('[data-noteact]');
      if (!hit) return;
      if (hit.dataset.noteact === 'edit') editNote(card, kind, idx);
      else confirmDelete(card, kind, idx);
    }, true);
    return card;
  }

  /* Deleting is one tap away from losing what someone wrote, so it asks —
     in the card itself, not in a dialog over the whole screen. */
  function confirmDelete(card, kind, idx) {
    if ($('[data-noteconfirm]', card)) return;
    var bar = document.createElement('div');
    bar.setAttribute('data-noteconfirm', '1');
    bar.setAttribute('style', 'display:flex;align-items:center;gap:9px;margin-top:11px;' +
      'padding-top:11px;border-top:1px solid #DDE3EE');
    bar.innerHTML = '<span style="flex:1;font:500 12.5px/1.35 Geist;color:#8A6114">Delete this note?</span>' +
      '<span data-no style="font:600 13px/1 Geist;color:#546478;padding:8px 10px">Keep</span>' +
      '<span data-yes style="font:600 13px/1 Geist;color:#fff;background:#DC2626;' +
      'border-radius:8px;padding:9px 13px">Delete</span>';
    $('[data-no]', bar).dataset.tap = '1';
    $('[data-yes]', bar).dataset.tap = '1';
    bar.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (ev.target.closest('[data-no]')) { bar.remove(); return; }
      if (!ev.target.closest('[data-yes]')) return;
      notes[kind].splice(idx, 1);
      saveNotes();
      paintNotes(kind);
      queued('Note');
      toast('Note deleted', 'delete_outline');
    }, true);
    card.appendChild(bar);
  }

  function noteEditor(value) {
    var box = document.createElement('div');
    box.setAttribute('data-noteeditor', '1');
    box.innerHTML =
      '<textarea class="inp" rows="3" placeholder="Write the note" ' +
      'style="height:auto;padding:11px 12px;font:400 15px/1.5 Geist;resize:none"></textarea>' +
      '<div style="display:flex;gap:9px;margin-top:9px">' +
      '<div data-cancel style="flex:1;height:46px;display:flex;align-items:center;justify-content:center;' +
      'background:#fff;border:1px solid #C8D5E8;color:#546478;border-radius:10px;font:600 14.5px/1 Geist">Cancel</div>' +
      '<div data-save style="flex:1;height:46px;display:flex;align-items:center;justify-content:center;' +
      'background:#4A6FA5;color:#fff;border-radius:10px;font:600 14.5px/1 Geist">Save note</div></div>';
    $('textarea', box).value = value || '';
    return box;
  }

  function editNote(card, kind, idx) {
    if ($('[data-noteeditor]', card)) return;
    var rec = notes[kind][idx];
    var box = noteEditor(rec.text);
    var hide = $$(':scope > div', card);
    hide.forEach(function (e) { toggleDisplay(e, false); });
    card.appendChild(box);
    var ta = $('textarea', box);
    setTimeout(function () { ta.focus(); }, 30);
    box.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (ev.target.closest('[data-cancel]')) { paintNotes(kind); return; }
      if (!ev.target.closest('[data-save]')) return;
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      rec.text = text;
      rec.stamp = noteStampNow();
      rec.author = 'Marek Stroz';          // whoever last touched it owns it
      saveNotes();
      paintNotes(kind);
      queued('Note');
      toast(net.online ? 'Note updated' : 'Note updated — will sync', 'edit_note');
    }, true);
  }

  /* =========================================================
     A half-written note is the thing most likely to be interrupted.

     The customer walks back in, the phone rings, the tech taps Photos to
     check what they just shot — and every one of those repainted the list
     and took the typing with it. A reload took it too. So the note got
     rewritten from memory, or more often not written at all.

     It is kept as a draft from the first keystroke, one per kind, the way
     the close-out already keeps its twelve fields. Come back to the sheet
     and the editor is open with the words still in it. Cancel is what
     throws a draft away, because Cancel is the only thing that means "I
     don't want this".
     ========================================================= */
  var noteDrafts = recall('notes.draft.v1', {}) || {};
  // a draft the technician just asked for should take the keyboard; one put
  // back by a repaint should not
  var focusDraft = false;

  function setDraft(kind, text) {
    if (text) noteDrafts[kind] = text; else delete noteDrafts[kind];
    remember('notes.draft.v1', noteDrafts);
  }

  function addNote(kind, box) {
    var editor = noteEditor(noteDrafts[kind] || '');
    box.appendChild(editor);
    var ta = $('textarea', editor);
    if (focusDraft) {
      setTimeout(function () {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;   // after what's there
      }, 30);
    }
    ta.addEventListener('input', function () { setDraft(kind, ta.value); });
    editor.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (ev.target.closest('[data-cancel]')) { setDraft(kind, ''); paintNotes(kind); return; }
      if (!ev.target.closest('[data-save]')) return;
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      notes[kind].unshift({ text: text, stamp: noteStampNow(), author: 'Marek Stroz' });
      saveNotes();
      setDraft(kind, '');
      paintNotes(kind);
      queued('Note');
      toast(net.online ? 'Note added' : 'Note saved — will sync', 'edit_note');
    }, true);
    return editor;
  }

  /* repaint every surface showing this kind — the tab and the dialog are
     two windows onto the same notes */
  function paintNotes(kind) {
    noteSurfaces.forEach(function (sf) {
      var k = sf.kind || tabNoteKind;
      if (kind && k !== kind) return;
      var spec = NOTE_KINDS[k];
      $$('[data-note],[data-noteeditor]', sf.box).forEach(function (e) { e.remove(); });
      notes[k].forEach(function (rec, i) { sf.box.appendChild(noteRow(k, rec, i)); });
      // a repaint is what used to lose the typing; now it puts it back
      if (noteDrafts[k] && !NOTE_KINDS[k].readOnly) addNote(k, sf.box);

      if (sf.banner) {
        var fresh = noteBanner(k);
        sf.banner.setAttribute('style', fresh.getAttribute('style'));
        sf.banner.innerHTML = fresh.innerHTML;
      }
      if (sf.addBtn) {
        toggleDisplay(sf.addBtn, !spec.readOnly);
        var lbl = sf.addBtn.lastChild;
        if (spec.add && lbl && lbl.nodeType === 3) lbl.nodeValue = spec.add;
      }
      if (sf.count) sf.count.textContent = String(notes[k].length);
    });
    paintNoteSegment();
  }

  function noteSurface(screenId, kind) {
    var root = byId(screenId); if (!root) return;
    var box = noteListBox(screenId);
    if (!box) { MISS.push(screenId + ' :: note list'); return; }
    var addBtn = sel(root, '@add^1')[0] || null;
    var count = null;
    $$('span', root).forEach(function (e) {
      if (!count && /^[0-9]+$/.test(norm(e.textContent)) &&
        /border-radius:5px/.test(e.getAttribute('style') || '')) count = e;
    });
    var banner = noteBanner(kind || 'detailed');
    box.parentElement.insertBefore(banner, box);
    box.innerHTML = '';
    var sf = { screen: screenId, kind: kind, box: box, addBtn: addBtn, banner: banner, count: count };
    noteSurfaces.push(sf);
    if (addBtn) {
      addBtn.dataset.tap = '1';
      addBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var k = sf.kind || tabNoteKind;
        if (NOTE_KINDS[k].readOnly) return;
        var open = $('[data-noteeditor]', sf.box);
        if (open) { $('textarea', open).focus(); return; }
        focusDraft = true;
        addNote(k, sf.box);
        focusDraft = false;
      }, true);
    }
  }

  /* the Notes tab's segment picks the kind; the dialogs are fixed to one */
  var tabNoteKind = 'detailed';
  function paintNoteSegment() {
    var root = byId('job-notes'); if (!root) return;
    NOTE_ORDER.forEach(function (k) {
      var spec = NOTE_KINDS[k];
      var el = $$('div', root).filter(function (e) {
        return !e.children.length && norm(e.textContent).indexOf(spec.seg + ' ') === 0;
      })[0];
      if (el) el.textContent = spec.seg + ' ' + notes[k].length;
    });
  }

  noteSurface('ov-note-detailed', 'detailed');
  noteSurface('ov-note-tech', 'tech');
  noteSurface('ov-note-private', 'private');
  noteSurface('job-notes', null);
  paintNotes();

  /* =========================================================
     The notes opened as a card floating in the middle of the screen,
     sized to whatever was inside it. Two notes fitted. A job with ten —
     which is the job these were drawn for, a customer with history — ran
     off the bottom of the screen with nothing to scroll and no Add button
     left in reach.

     They are sheets now, the same ones the date picker uses: pinned to
     the bottom edge where a thumb is, the title and the Add button held
     still, and only the notes moving between them.
     ========================================================= */
  noteSurfaces.forEach(function (sf) {
    if (sf.screen.indexOf('ov-note-') !== 0) return;
    var card = sf.box.parentElement;
    var head = card.firstElementChild;
    if (!head) { MISS.push(sf.screen + ' :: note sheet'); return; }

    card.setAttribute('style',
      'position:absolute;left:0;right:0;bottom:0;max-height:86%;display:flex;' +
      'flex-direction:column;background:#fff;border-radius:22px 22px 0 0;overflow:hidden;' +
      'box-shadow:0 -8px 30px rgba(26,35,50,.22)');

    /* The private sheet was amber three times over — its edge, its title bar
       and the banner under them. The banner is the one saying the thing, so
       it keeps the colour and the chrome around it goes quiet. */
    var hs = head.getAttribute('style') || '';
    head.setAttribute('style', hs
      .split('background:#FEF3E2;').join('')
      .split('border-bottom:1px solid #F3D9AE').join('border-bottom:1px solid #EDF0F5'));
    // the count chip and the close were drawn amber to sit on an amber bar;
    // off it they are just more orange, so they match the other two sheets
    $$('span', head).forEach(function (e) {
      var st = e.getAttribute('style') || '';
      if (!/#B45309|#D97706|#8A6114/.test(st)) return;
      e.setAttribute('style', st
        .split('#B45309').join('#4A6FA5')
        .split('#D97706').join('#4A6FA5')
        .split('#8A6114').join('#546478')
        .split('background:#fff').join('background:#EBF0F8'));
    });

    var grip = document.createElement('div');
    grip.setAttribute('style', 'display:flex;justify-content:center;padding:10px 0 4px;flex:none');
    grip.innerHTML = '<div style="width:38px;height:4px;border-radius:2px;background:#DDE3EE"></div>';
    card.insertBefore(grip, head);

    // a way back on the left, where every other sheet in the app keeps one
    var back = document.createElement('span');
    back.className = 'mi';
    back.setAttribute('style', 'font-size:22px;color:#546478');
    back.textContent = 'arrow_back';
    head.insertBefore(back, head.firstElementChild);
    // the kind had an icon of its own next to it; the banner right below
    // already says who reads these, so the icon was only crowding the title
    var kindIcon = head.children[1];
    if (kindIcon && kindIcon.classList.contains('mi') &&
      !/arrow_back|close/.test(kindIcon.textContent)) kindIcon.remove();

    $$(':scope > div', card).forEach(function (el) { el.style.flex = 'none'; });
    sf.box.className = 'sc';
    sf.box.style.flex = '1';
    sf.box.style.overflowY = 'auto';
    sf.box.style.paddingBottom = '16px';
  });

  /* =========================================================
     Calling the customer on the way is what techs did before it was taken
     away from them. The number looked like a control and did nothing — and
     on the job card it sat inside the card's own tap target, so pressing it
     opened the job instead.
     ========================================================= */
  var PHONE_RE = /^\(\d{3}\)\s?\d{3}-\d{4}$/;

  // the job card paints before the numbers are made callable, so handle both
  function setPhone(el, num) {
    var a = $('a[data-tel]', el);
    if (!a) { el.textContent = num; return; }
    a.textContent = num;
    a.href = 'tel:+1' + num.replace(/\D/g, '');
  }

  function makeCallable(el) {
    if ($('a[data-tel]', el)) return;
    var num = norm(el.textContent);
    var a = document.createElement('a');
    a.dataset.tel = '1';
    a.href = 'tel:+1' + num.replace(/\D/g, '');
    a.textContent = num;
    a.setAttribute('style', 'color:inherit;text-decoration:none');
    el.textContent = '';
    el.appendChild(a);
    el.dataset.tap = '1';
    // the number sits inside cards that navigate; dialling must not also
    // open the job behind it
    a.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toast('Calling ' + norm(a.textContent), 'call');
    });
  }

  $$('.screen,.overlay', phone).forEach(function (root) {
    $$('span,div', root).forEach(function (e) {
      if (e.children.length || !PHONE_RE.test(norm(e.textContent))) return;
      makeCallable(e);
    });
    // the handset icon beside a number dials the same number
    byIcon(root, 'call').forEach(function (ic) {
      var row = ic.parentElement;
      var a = row && $('a[data-tel]', row);
      if (!a) return;
      ic.dataset.tap = '1';
      ic.addEventListener('click', function (ev) { ev.stopPropagation(); a.click(); }, true);
    });
  });

  /* =========================================================
     Report Card ratings that count. Each Good / Attention / Immediate row is
     its own three-way control, the pick is kept, and the section badges on
     the overview move with them — so a tech sees where the red is before
     opening anything, which is what the badges were drawn for.
     ========================================================= */
  function rcPicks() {
    var p = recall('rcPicks', null);
    if (!p) { p = {}; remember('rcPicks', p); }
    return p;
  }
  function ratingRows(screenId) {
    var root = byId(screenId); if (!root) return;
    // the first three children are the control; a slot camera may follow them
    // in the same row (Household's Wi-Fi item does exactly that)
    var rows = $$('div', root).filter(function (e) {
      return e.children.length >= 3 && RATING.every(function (l, i) { return norm(e.children[i].textContent) === l; });
    });
    var picks = rcPicks();
    // The two looks are fixed, not read off the DOM: reading them at wire time
    // breaks the moment a row has already been painted (a second pass, or a
    // restore) — the "inactive" sample is then an active cell, and every row
    // comes out inverted.
    var RATE_BASE = 'flex:1;height:44px;display:flex;align-items:center;justify-content:center;border-radius:8px;';
    var RATE_OFF = RATE_BASE + 'background:#fff;border:1px solid #DDE3EE;color:#546478;font:500 13px/1 Geist';
    var RATE_ON = { 0: '#16A34A', 1: '#D97706', 2: '#DC2626' };
    rows.forEach(function (row, idx) {
      if (row.dataset.rated) return;            // never wire the same row twice
      row.dataset.rated = '1';
      var key = screenId + ':' + idx;
      var kids = Array.prototype.slice.call(row.children, 0, 3);
      function paint(i) {
        kids.forEach(function (k, j) {
          k.setAttribute('style', j === i
            ? RATE_BASE + 'background:' + RATE_ON[i] + ';color:#fff;font:600 13px/1 Geist'
            : RATE_OFF);
        });
      }
      kids.forEach(function (k, i) {
        k.dataset.tap = '1'; k.dataset.seg = '1';
        k.addEventListener('click', function (ev) {
          ev.stopPropagation();
          paint(i);
          picks[key] = i;
          remember('rcPicks', picks);
          paintRcBadges();
          if (typeof showSaveBar === 'function') showSaveBar(screenId);
        }, true);
      });
      if (picks[key] !== undefined) paint(picks[key]);      // restored from the last session
    });
  }

  /* Badges start from the design's own numbers and move by what the tech
     changed; red if anything in the group is Immediate. */
  function paintRcBadges() {
    var root = byId('rc-overview'); if (!root) return;
    var picks = rcPicks(), touched = false;
    Object.keys(RC_GROUPS).forEach(function (title) {
      var g = RC_GROUPS[title], extra = 0, red = false;
      Object.keys(picks).forEach(function (k) {
        var scr = k.split(':')[0];
        if (g.screens.indexOf(scr) < 0) return;
        touched = true;
        if (picks[k] > 0) extra++;
        if (picks[k] === 2) red = true;
      });
      // find the badge once and keep it: writing to .style re-serialises the
      // attribute ("border-radius: 13px"), so matching it again would fail
      if (!g.badge) {
        var t = sel(root, title)[0]; if (!t) return;
        g.badge = $$('span', t.parentElement).filter(function (s) {
          return /border-radius:\s*13px/.test(s.getAttribute('style') || '');
        })[0];
      }
      var badge = g.badge;
      if (!badge) return;
      badge.textContent = String(g.base + extra);
      badge.style.background = red ? '#FDECEC' : '#FEF3E2';
      badge.style.color = red ? '#DC2626' : '#D97706';
    });
    if (touched) {
      var lc = $$('span', root).filter(function (s) { return /^Latest change:/.test(norm(s.textContent)); })[0];
      if (lc) lc.textContent = 'Latest change: ' + stamp() + ' (Marek Stroz)';
    }
  }

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
      remember('signedIn', true);        // US-M02-2: stays signed in across days
      go(homeScreen(), 'root');
      toast('Welcome back, Marek', 'waving_hand');
    }, 620);
  }
  byId('li-go').addEventListener('click', signIn);
  byId('li-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });

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
    { id: 'login', title: 'Sign in', section: 'auth', desc: 'Email and password' },
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
      var base = { 'ov-job-actions': 'job-general', 'ov-option-menu': 'est-draft', 'ov-pay-method': 'fin-empty', 'ov-inv-share': 'inv-sent', 'ov-period': 'home', 'ov-period-month': 'home', 'ov-note-detailed': 'job-general', 'ov-note-tech': 'job-general', 'ov-note-private': 'job-general', 'ov-media-source': 'home-active' }[id] || 'home';
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


  /* ---------- boot ---------- */
  function boot() {
    stack = [{ id: 'splash', mode: 'root' }];
    $$('.screen,.overlay', phone).forEach(function (e) { e.classList.remove('on', 'leaving'); });
    byId('splash').classList.add('on');
    chrome();
    setTimeout(function () { byId('splashBar').style.width = '100%'; }, 120);
    // "keep me signed in" means exactly that — no login every morning
    setTimeout(function () { go(recall('signedIn', false) ? homeScreen() : 'login', 'replace'); }, 1600);
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
