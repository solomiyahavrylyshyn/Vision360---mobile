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
        return { est: j.est, inv: j.inv, items: j.items, sold: j.sold };
      }));
    }
    paintDash();
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

    /* What the tech actually ticked, so it can be carried into the option. */
    return {
      selection: function () {
        return pills.filter(function (p) { return p.dataset.on === '1'; }).map(function (p) {
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
            labor: known ? known.labor : 0
          };
        });
      },
      clear: function () {
        pills.forEach(function (p) {
          if (p.dataset.on !== '1') return;
          p.dataset.on = '0';
          p.innerHTML = ADD.html;
          p.setAttribute('style', ADD.style);
        });
        base.n = 0; base.sum = 0; render();
      }
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

    start: function () {
      state.onsite = true;
      state.enroute = false;          // you've arrived — the en route state is spent
      paintEnroute();
      setClock('work');
      go('home-active', 'root');
      queued('Job status');
      toast('Job started · timer running', 'play_circle');
    },
    enroute: function () {
      state.enroute = !state.enroute;
      paintEnroute();
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
      renderOptionItems();
      go('est-new-option', 'modal');
    },
    estSaveOption: function () {
      if (!optionItems.length) {
        toast('Add at least one item before saving the option', 'info');
        return;
      }
      var first = state.est === 'none';
      state.est = 'draft';
      var total = optionItems.reduce(function (a, it) { return a + it.price * it.qty; }, 0);
      var added = first ? true : addOption(total, optionItems);
      optionItems = [];
      renderOptionItems();
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
        toast('The customer signs first — that signature is the order', 'draw');
        return;
      }
      var pick = pickedOption;
      var total = OPTION_TOTALS[pick] || 0;
      var j = JOBS[jobIdx];
      state.est = 'approved';
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
      toast('Declined — estimate stays open to present again', 'history_toggle_off');
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
        var seen = optionItems.filter(function (o) { return o.name === it.name; })[0];
        if (seen) seen.qty++;                       // same item twice = quantity, not a duplicate row
        else optionItems.push({
          sku: it.sku, name: it.name, desc: it.desc, warranty: it.warranty,
          price: it.price, type: it.type, cat: it.cat, labor: it.labor,
          qty: 1
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
      back();
      toast(net.online ? 'Report Card saved' : 'Report Card saved locally — will sync');
    },
    present: function () { estPresented = true; go('est-customer', 'modal'); },
    pickGallery: function () {
      galClear();
      closeOverlays(false);
      go('gallery', 'modal');
    },
    useCamera: function () {
      mediaBatch = 1;
      closeOverlays(false);
      go('image-desc', 'modal');
    },
    galDone: function () {
      if (!galPicked.length) return;
      mediaBatch = galPicked.length;
      go('image-desc', 'replace');
    },
    mediaSaved: function () {
      var bound = pendingSlot;
      var n = Math.max(1, mediaBatch);
      if (bound) {
        markSlotFilled(bound);
        pendingSlot = null;
      }
      addMediaThumbs(n);
      photosThisVisit += n;
      mediaBatch = 1;
      back();
      // back() doesn't run the per-screen paint, and the install card is
      // counting these photos
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
      state.enroute = false;
      state.extra = false;
      paintEnroute();
      jobIdx++;
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
    'home-active': [
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
      ['@tune^1', 'est-option', 'modal'],
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

  /* The photo viewer is drawn white-on-dark — header, pager, chevrons all
     assume it. The board carried that background on the frame itself, which
     is the one thing the export does not bring across, so the screen came
     out on the app's light ground and the header went invisible.
     Same colour as the image area, so the viewer is one dark surface. */
  (function () {
    var v = byId('photo-detail'); if (!v) { MISS.push('photo-detail :: screen'); return; }
    v.style.background = '#0B1116';
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
  seg('est-catalog', ['Repairs', 'Equipment', 'Ductwork', 'IAQ', 'Others'], 0);
  seg('est-new-option', ['Monthly payment + Total', 'Total only', 'Monthly payment only'], 0);
  seg('est-option', ['−20%', '0%', '+20%'], 1);
  /* The radio the customer actually taps. Everything downstream used to
     assume Option C no matter what was ticked, so the KPI, the day's sold
     figure and the confirmation all recorded an option nobody chose. */
  var pickedOption = 'Option A';        // the design's own checked radio
  seg('est-customer', ['Option A^1', 'Option B^1', 'Option C^1'], 0, function (i, label) {
    pickedOption = label.split('^')[0];
  });
  seg('history', ['Today', 'Week', 'Month', 'Quarter'], 0);
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

  function paintOptionSummary() {
    var total = optionItems.reduce(function (a, it) { return a + it.price * it.qty; }, 0);
    var n = optionItems.reduce(function (a, it) { return a + it.qty; }, 0);
    if (optSummary.count) optSummary.count.textContent = String(n);
    if (optSummary.monthly) optSummary.monthly.textContent = fmt(monthlyFor(total));
    if (optSummary.total) optSummary.total.textContent = fmt(total);
  }

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

    $$('[data-tsmode]').forEach(function (b) {
      var on = b.dataset.tsmode === clock.mode || (b.dataset.tsmode === 'off' && clock.mode === 'off');
      b.setAttribute('style', 'flex:1;text-align:center;padding:10px 0;border-radius:7px;' +
        (on ? 'font:600 13.5px/1 Geist;color:#1C2B3A;background:#fff'
            : 'font:500 13.5px/1 Geist;color:#9DB4D6'));
    });
  }

  $$('[data-tsmode]').forEach(function (b) {
    b.dataset.tap = '1';
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var m = b.dataset.tsmode;
      setClock(m);
      toast(m === 'off' ? 'Clocked out' : 'Clocked in — ' + MODE_LABEL[m][0].toLowerCase(),
        m === 'drive' ? 'navigation' : m === 'work' ? 'play_circle' : 'stop_circle');
    }, true);
  });
  setInterval(function () { if (clock.mode !== 'off') paintClock(); }, 1000);
  paintClock();

  /* =========================================================
     US-M06-4 — a photo upload is visible while it happens, says whether
     it landed, and offers a retry for the ones that didn't. The counts
     around the app move only once the upload actually succeeds, so a
     failure can't quietly inflate them.
     ========================================================= */
  var photoCount = recall('photoCount', 24);
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
      var title = sel(ph, 'Photos')[0];
      var badge = title && title.nextElementSibling;
      if (badge && /^\d+$/.test(norm(badge.textContent))) {
        countRefs.push(function (n) { badge.textContent = String(n); });
      }
      var all = sel(ph, 'All 24')[0];
      if (all) countRefs.push(function (n) { all.textContent = 'All ' + n; });
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

  /* How many this save is filing, and — when a Report Card slot owns the
     photo — that Before / After is not the technician's call here. */
  var mediaCaption = null;
  (function dropTypePicker() {
    /* One Before / After for a whole batch is a trap: you tick four photos,
       hit Save, and only then remember two of them were the before shots.
       Asking once per batch would mislabel them; asking per photo puts the
       four taps back that the batch just removed. So capture stops
       claiming to know, and the label is left to be set on the photo
       itself. A Report Card photo was never labelled this way anyway —
       the slot names it. */
    var root = byId('image-desc'); if (!root) return;
    var typeLabel = sel(root, 'Image type')[0];
    var typeRow = typeLabel && typeLabel.nextElementSibling;
    if (!typeLabel || !typeRow) { MISS.push('image-desc :: type picker'); return; }
    typeRow.remove();
    typeLabel.remove();
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
        ' — one description for all of them';
    }
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
  /* The n/14 chip on each KPI card is unexplained on the card and
     unexplained anywhere else — a technician reading "7/14" cannot tell
     whether it is a rank, a countdown or a quota, and nothing in the app
     answers it. A number nobody can act on is noise on the one screen
     that has to read at a glance. */
  (function () {
    var root = byId('home'); if (!root) return;
    $$('span', root).forEach(function (e) {
      if (/^[0-9]{1,2}[/]14$/.test(norm(e.textContent)) && !e.children.length) e.remove();
    });
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
    if (r.avg) { setLead(r.avg.value, kfmt(kpi.avgTicket)); if (r.avg.bar) r.avg.bar.style.width = pct(kpi.avgTicket, kpi.avgTarget) + '%'; }
    if (r.close) {
      var cl = kpi.closed / kpi.estimates * 100;
      setLead(r.close.value, Math.round(cl) + '%');
      if (r.close.bar) r.close.bar.style.width = pct(cl, kpi.closeTarget) + '%';
      if (r.estCount) r.estCount.textContent = 'Of ' + kpi.estimates + ' estimates';
    }
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
     US-M03-9 (policy) — a technician sees only the job in front of
     them. The next one unlocks when the current one is closed out, so
     every call is treated as the only call and nobody cherry-picks.
     This is why the design's "2 of 3" pager is not wired as a pager.
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

  (function () {
    var root = byId('est-new-option'); if (!root) return;
    var head = sel(root, 'Pricing preview type')[0];
    if (!head) { MISS.push('est-new-option :: preview type'); return; }
    var why = document.createElement('div');
    why.setAttribute('style', 'font:400 12.5px/1.45 Geist;color:#8A97A8;margin:-3px 0 9px');
    why.textContent = 'What the customer sees on the option card when you present it.';
    head.parentElement.insertBefore(why, head.nextElementSibling);

    // the label is a span inside the row; the row is what carries the state
    seg('est-new-option',
      ['Monthly payment + Total^1', 'Total only^1', 'Monthly payment only^1'], 0,
      function (i) {
        previewMode = PREVIEW[i];
        paintPlanEverywhere();
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

  var EST_BADGE = {
    draft: ['Draft estimate', '#546478', '#F5F7FA', '#DDE3EE'],
    review: ['Estimate in review', '#B45309', '#FEF3E2', '#F3D9AE'],
    ready: ['Estimate ready to present', '#15803D', '#E8F6ED', '#B6E3C6'],
    approved: ['Estimate approved', '#15803D', '#E8F6ED', '#B6E3C6']
  };
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
      toggleDisplay(b, !state.onsite);
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

    // The whole pager goes: the arrows let a tech look ahead, and even a bare
    // "2 of 3" says more work is queued. Neither survives the policy — the
    // screen shows one job and says nothing about what comes after it.
    prev.style.display = 'none';
    next.style.display = 'none';
    counter.style.display = 'none';
    heading.textContent = 'Current job';

    // a chip so the tech knows there's already an estimate before opening it
    var estBadge = document.createElement('span');
    estBadge.hidden = true;
    refs.type.parentElement.appendChild(estBadge);

    paintJob = function () {
      var j = JOBS[jobIdx];
      if (!j) {
        heading.textContent = 'Nothing left today';
        return;
      }
      var b = EST_BADGE[j.est];
      estBadge.hidden = !b;
      if (b) {
        estBadge.setAttribute('style',
          'font:600 11.5px/1 Geist;color:' + b[1] + ';background:' + b[2] +
          ';border:1px solid ' + b[3] + ';border-radius:5px;padding:4px 7px');
        estBadge.textContent = b[0];
      }
      refs.name.textContent = j.name;
      refs.when.textContent = j.when;
      refs.brief.textContent = j.brief;
      refs.type.textContent = j.type;
      setPhone(refs.phone, j.phone);
      addr.childNodes[0].nodeValue = j.addr;
      awaySpan.textContent = j.away;
    };
    paintJob();
  }

  /* The in-progress screen is the same job — it can't keep showing the
     customer from the design mockup once the tech has moved on. */
  function wireActiveJobCard() {
    var root = byId('home-active'); if (!root) return;
    var refs = {
      name: sel(root, 'Randy Johnson')[0],
      when: sel(root, 'Today, 8:00 AM')[0],
      brief: sel(root, 'AC not cooling')[0],
      type: sel(root, 'Estimate')[0],
      phone: sel(root, '(123) 456-7890')[0],
      banner: sel(phone, 'On site · Randy Johnson')[0]   // now phone chrome
    };
    var addrRow = sel(root, '@place^1')[0];
    var addr = addrRow ? $('div', addrRow) : null;
    var away = addr ? $('span', addr) : null;
    if (!refs.name || !addr || !away) { MISS.push('home-active :: job card'); return; }

    var prev = paintJob;
    paintJob = function () {
      prev();
      var j = JOBS[jobIdx]; if (!j) return;
      refs.name.textContent = j.name;
      if (refs.banner) refs.banner.textContent = 'On site · ' + j.name;
      if (refs.when) refs.when.textContent = j.when;
      if (refs.brief) refs.brief.textContent = j.brief;
      if (refs.type) refs.type.textContent = j.type;
      if (refs.phone) setPhone(refs.phone, j.phone);
      addr.childNodes[0].nodeValue = j.addr;
      away.textContent = j.away;
    };
  }

  // pick up where the tech left off: which job, each job's stage, and the
  // session flags — before the cards are painted
  jobIdx = recall('jobIdx', 0);
  (recall('jobs', []) || []).forEach(function (s, i) {
    if (!JOBS[i] || !s) return;
    JOBS[i].est = s.est; JOBS[i].inv = s.inv;
    if (s.items) JOBS[i].items = s.items;
    if (s.sold !== undefined) JOBS[i].sold = s.sold;
  });
  loadJob();
  (function () {
    var s = recall('state', null);
    if (s) { state.onsite = !!s.onsite; state.enroute = !!s.enroute; state.extra = !!s.extra; }
  })();
  wireCurrentJob();
  wireActiveJobCard();
  paintJob();

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

    /* this replaces the earlier painter, which captured the outlined style
       the button no longer wears */
    paintEnroute = function () {
      if (state.enroute) {
        enroute.setAttribute('style', DRIVING);
        enroute.innerHTML = '<span class="mif" style="font-size:17px">stop_circle</span>' +
          '<span data-drivetime>0:00</span>';
      } else {
        enroute.setAttribute('style', PRIMARY);
        enroute.innerHTML = '<span class="mif" style="font-size:18px">navigation</span>En route';
      }
      paintDriveTime();
    };
    paintEnroute();
  })();

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

  /* =========================================================
     A customer saying no is a state the app has to hold. Without it the
     estimate is stuck "ready to present" forever and the tech has to
     rebuild the call when they change their mind on the doorstep.
     ========================================================= */
  (function () {
    var root = byId('est-customer'); if (!root) return;
    var confirm = sel(root, '@check_circle^1')[0];
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
    var name = 'Option ' + String.fromCharCode(65 + optCount);
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

  function addNote(kind, box) {
    var editor = noteEditor('');
    box.appendChild(editor);
    var ta = $('textarea', editor);
    setTimeout(function () { ta.focus(); }, 30);
    editor.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (ev.target.closest('[data-cancel]')) { paintNotes(kind); return; }
      if (!ev.target.closest('[data-save]')) return;
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      notes[kind].unshift({ text: text, stamp: noteStampNow(), author: 'Marek Stroz' });
      saveNotes();
      paintNotes(kind);
      queued('Note');
      toast(net.online ? 'Note added' : 'Note saved — will sync', 'edit_note');
    }, true);
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
        if ($('[data-noteeditor]', sf.box)) return;
        addNote(k, sf.box);
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
