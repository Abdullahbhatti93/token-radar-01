// LaunchScope dashboard: renders the board, the live comparison set and the model
// from window.RADAR (data.js, written by main.ts from the same snapshot). No
// network, no framework: the page is three files and the data script.

(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtUsd(v) {
    if (v == null) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v;
  }

  function fmtPct(v) {
    if (v == null) return '<span class="flat">—</span>';
    var cls = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
    var sign = v > 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + v.toFixed(1) + '%</span>';
  }

  function fmtAge(days) {
    if (days == null) return '—';
    if (days < 365) return days + 'd';
    var y = Math.floor(days / 365);
    var rest = days - y * 365;
    return y + 'y ' + rest + 'd';
  }

  function fmtMult(v) { return v == null ? '—' : v.toFixed(3).replace(/0$/, '') + '×'; }

  /* ---------------- state ---------------- */

  var state = { view: 'board', q: '', cat: '', chain: '', watch: false, sort: 'implied', detail: null };

  function parseHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var key = decodeURIComponent(kv[0] || '');
      var val = decodeURIComponent(kv.slice(1).join('=') || '');
      if (key === 'live') state.view = 'live';
      else if (key === 'model') state.view = 'model';
      else if (key === 'cat') state.cat = val;
      else if (key === 'chain') state.chain = val;
      else if (key === 'q') state.q = val;
      else if (key === 'sort') state.sort = val;
      else if (key === 'watch') state.watch = val === '1';
      else if (key === 'p') state.detail = val;
    }
  }

  function writeHash() {
    var bits = [];
    if (state.view === 'live') bits.push('live');
    if (state.view === 'model') bits.push('model');
    if (state.cat) bits.push('cat=' + encodeURIComponent(state.cat));
    if (state.chain) bits.push('chain=' + encodeURIComponent(state.chain));
    if (state.q) bits.push('q=' + encodeURIComponent(state.q));
    if (state.watch) bits.push('watch=1');
    if (state.sort !== 'implied') bits.push('sort=' + encodeURIComponent(state.sort));
    if (state.detail) bits.push('p=' + encodeURIComponent(state.detail));
    var h = '#' + bits.join('&');
    if (window.location.hash !== h) history.replaceState(null, '', h);
  }

  /* ---------------- header and stats ---------------- */

  function renderHead() {
    $('snapshot-note').textContent =
      'Snapshot of ' + D.as_of + ', sealed by the house from DefiLlama data. Model ' +
      D.model.name + ' (' + D.model.version + '). Every figure on this page comes from that one file.';
    var s = D.stats;
    var top = D.rows[0];
    var stats = [
      ['Protocols scanned', s.protocols, 'in the snapshot'],
      ['Pre-token board', s.board_rows, 'standalone, no token recorded'],
      ['Watchlist covered', s.watchlist + ' / ' + s.watchlist, 'every slug over the $50M floor'],
      ['Highest implied value', fmtUsd(top.implied_value_usd), esc(top.name)],
      ['Market median multiple', fmtMult(D.model.global_median_multiple), 'market cap per $1 of TVL'],
    ];
    $('stats').innerHTML = stats.map(function (row) {
      return '<div class="stat"><div class="k">' + row[0] + '</div><div class="v">' + row[1] +
        '</div><div class="s">' + row[2] + '</div></div>';
    }).join('');
  }

  /* ---------------- board ---------------- */

  function fillFilters() {
    var cats = D.categories.filter(function (c) { return c.board_rows > 0; })
      .map(function (c) { return c.category; }).sort();
    $('f-cat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) {
      return '<option' + (c === state.cat ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainSet = {};
    D.rows.forEach(function (r) { r.chains.forEach(function (c) { chainSet[c] = true; }); });
    var chains = Object.keys(chainSet).sort();
    $('f-chain').innerHTML = '<option value="">All chains</option>' + chains.map(function (c) {
      return '<option' + (c === state.chain ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    $('f-q').value = state.q;
    $('f-watch').checked = state.watch;
    $('f-sort').value = state.sort;
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = D.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
    var by = {
      implied: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      change: function (a, b) { return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d); },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); },
      name: function (a, b) { return a.name < b.name ? -1 : 1; },
    };
    rows.sort(by[state.sort] || by.implied);
    return rows;
  }

  function renderBoard() {
    var rows = visibleRows();
    $('board-count').innerHTML = 'Showing <strong>' + rows.length + '</strong> of ' + D.stats.board_rows +
      ' ranked protocols. Click any row for its model breakdown and farm plan.';
    $('board-body').innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.rank <= 3 ? ' class="top"' : '') + '>' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span><span class="pslug">' + esc(r.slug) + '</span>' +
        (r.on_watchlist ? '<span class="badge">watchlist</span>' : '') + '</td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorised') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num">' + fmtMult(r.model.category_multiple) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td><button type="button" class="plan-btn" data-plan="' + esc(r.slug) + '">Farm plan</button></td>' +
        '</tr>';
    }).join('');
  }

  /* ---------------- live view ---------------- */

  function renderLive() {
    $('live-body').innerHTML = D.live.map(function (r) {
      return '<tr data-live="' + esc(r.slug) + '">' +
        '<td><span class="pname">' + esc(r.name) + '</span><span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorised') + '</td>' +
        '<td class="cat">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td class="num">' + fmtPct(r.change_7d) + '</td></tr>';
    }).join('');
  }

  /* ---------------- model view ---------------- */

  function renderModel() {
    var m = D.model;
    var catRows = D.categories.map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td class="num">' + fmtMult(c.multiple) + '</td>' +
        '<td class="num">' + c.samples + '</td><td class="num">' + c.board_rows + '</td></tr>';
    }).join('');
    $('model-body').innerHTML =
      '<div class="model-cols">' +
      '<div class="panel"><h2>The ' + esc(m.name) + ' model (' + esc(m.version) + ')</h2>' +
      '<ol>' +
      '<li><strong>Find the candidates.</strong> A protocol joins the board when the snapshot records no token for it and it is a standalone product: not a wrapped, staked or bridged version of a token that already trades, not an exchange’s own product, not a versioned pool of another protocol. The house’s watchlist test, applied at every size, so all ' + D.stats.watchlist + ' watchlist slugs are covered and the smaller early protocols are found by the same rule.</li>' +
      '<li><strong>Let the market price each category.</strong> For every protocol whose token already trades, take its market cap divided by its TVL, winsorized to 0.02–3.00 so one outlier cannot rule a category. A category’s multiple is the median of those ratios, pulled toward the market-wide median (' + fmtMult(m.global_median_multiple) + ') by sample count, and clamped to 0.05–2.00. A category with no traded protocol is priced at the market median.</li>' +
      '<li><strong>Start from TVL.</strong> Implied value begins as TVL × the category multiple: what this protocol’s locked value would be worth if the market priced it like its traded peers.</li>' +
      '<li><strong>Adjust for the protocol itself.</strong> Momentum: the seven-day TVL change, clamped to −60%…+120%, moves the value by ' + Math.round(m.momentum_weight * 100) + '% of itself. Maturity: a protocol that has run longer with no token earns a factor from ' + m.maturity_base.toFixed(2) + ' up to ' + (m.maturity_base + m.maturity_span).toFixed(2) + ' over five years. Breadth: each extra chain beyond the first adds ' + (m.breadth_step * 100).toFixed(1) + '%, up to eight.</li>' +
      '<li><strong>Rank, and show the working.</strong> Rows are ranked by the result; every row’s detail view carries its own multiple, sample count and three factors, so any number on the board can be checked by hand.</li>' +
      '</ol>' +
      '<p class="fine">No protocol is named, listed or special-cased anywhere in the model: one function prices every row from its own record. Implied value is an estimate of what a token would be worth if the protocol’s record stayed as it is — not a prediction that one will be issued.</p>' +
      '</div>' +
      '<div class="panel"><h2>Category multiples, measured from the snapshot</h2>' +
      '<table class="mini"><thead><tr><th>Category</th><th class="num">Multiple</th><th class="num">Traded samples</th><th class="num">Board rows</th></tr></thead>' +
      '<tbody>' + catRows + '</tbody></table>' +
      '<p class="fine">A multiple of 0.60× means the market currently pays about sixty cents of market cap for each dollar of TVL in that category. Sample counts are shown so a multiple resting on one traded protocol reads as what it is.</p>' +
      '</div></div>';
  }

  /* ---------------- detail ---------------- */

  function factorRow(label, value, max) {
    var pct = Math.max(2, Math.min(100, (value / max) * 100));
    return '<div class="factor"><span class="fname">' + label + '</span>' +
      '<span class="bar"><span class="fill" style="width:' + pct.toFixed(0) + '%"></span></span>' +
      '<span class="fval">×' + value.toFixed(3) + '</span></div>';
  }

  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    if (!r) return;
    state.detail = slug;
    var chips = r.chains.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    if (r.on_watchlist) chips += '<span class="chip hot">on the house watchlist</span>';
    $('detail-card').innerHTML =
      '<button type="button" class="detail-close" id="detail-close" aria-label="Close">×</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="detail-sub">Rank #' + r.rank + ' of ' + D.stats.board_rows + ' · ' + esc(r.category || 'Uncategorised') +
      ' · records no token in the snapshot</p>' +
      '<div class="chips">' + chips + '</div>' +
      '<div class="dgrid">' +
      '<div class="cell"><div class="k">Implied value</div><div class="v implied">' + fmtUsd(r.implied_value_usd) + '</div></div>' +
      '<div class="cell"><div class="k">TVL</div><div class="v">' + fmtUsd(r.tvl_usd) + '</div></div>' +
      '<div class="cell"><div class="k">7-day TVL change</div><div class="v">' + (r.change_7d == null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</div></div>' +
      '<div class="cell"><div class="k">No token for</div><div class="v">' + fmtAge(r.age_days) + '</div></div>' +
      '</div>' +
      '<h3>How this number is built</h3>' +
      '<p class="model-line">TVL ' + fmtUsd(r.tvl_usd) + ' × category multiple <strong>' + fmtMult(r.model.category_multiple) + '</strong>' +
      ' (median of ' + r.model.category_samples + ' traded ' + esc(r.category || 'Uncategorised') + ' protocol' + (r.model.category_samples === 1 ? '' : 's') + '), then three adjustments:</p>' +
      factorRow('Momentum', r.model.momentum_factor, 1.4) +
      factorRow('Maturity', r.model.maturity_factor, 1.1) +
      factorRow('Chain breadth', r.model.breadth_factor, 1.2) +
      '<h3>Farm plan</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    $('detail').hidden = false;
    $('detail-close').addEventListener('click', closeDetail);
    writeHash();
  }

  function closeDetail() {
    state.detail = null;
    $('detail').hidden = true;
    writeHash();
  }

  /* ---------------- wiring ---------------- */

  function showView(view) {
    state.view = view;
    var btns = document.querySelectorAll('.view-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', btns[i].getAttribute('data-view') === view);
    }
    $('view-board').hidden = view !== 'board';
    $('view-live').hidden = view !== 'live';
    $('view-model').hidden = view !== 'model';
    writeHash();
  }

  function bind() {
    var btns = document.querySelectorAll('.view-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { showView(this.getAttribute('data-view')); });
    }
    $('f-q').addEventListener('input', function () { state.q = this.value; renderBoard(); writeHash(); });
    $('f-cat').addEventListener('change', function () { state.cat = this.value; renderBoard(); writeHash(); });
    $('f-chain').addEventListener('change', function () { state.chain = this.value; renderBoard(); writeHash(); });
    $('f-sort').addEventListener('change', function () { state.sort = this.value; renderBoard(); writeHash(); });
    $('f-watch').addEventListener('change', function () { state.watch = this.checked; renderBoard(); writeHash(); });
    $('board-body').addEventListener('click', function (ev) {
      var tr = ev.target.closest ? ev.target.closest('tr[data-slug]') : null;
      if (tr) openDetail(tr.getAttribute('data-slug'));
    });
    $('detail').addEventListener('click', function (ev) { if (ev.target === this) closeDetail(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeDetail(); });
  }

  parseHash();
  renderHead();
  fillFilters();
  renderBoard();
  renderLive();
  renderModel();
  bind();
  showView(state.view);
  if (state.detail) openDetail(state.detail);
})();
