/* ═══════════════════════════════════════════════════════════════
   Academic Project Page — Interactivity
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initComparisonSliders();
  initCarousels();
  initCopyButtons();
  initLazyVideos();
  initLazyIframes();
  initStickyHeader();
  initPoll();
  initInfoModals();
  initPolicyGrid();
  buildDynamicToc();
});

/* ── Tabs ──────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('[data-tabs]').forEach(tabGroup => {
    const buttons  = tabGroup.querySelectorAll('.tab-btn');
    const contents = tabGroup.querySelectorAll('.tab-content');

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b  => b.classList.remove('active'));
        contents.forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const target = tabGroup.querySelector('#' + btn.dataset.tab);
        if (target) target.classList.add('active');
      });
    });
  });
}

/* ── Image Comparison Slider ───────────────────────────────── */
function initComparisonSliders() {
  document.querySelectorAll('[data-comparison]').forEach(slider => {
    const before = slider.querySelector('.comparison-before');
    const handle = slider.querySelector('.comparison-handle');
    let isDragging = false;

    function setPosition(x) {
      const rect = slider.getBoundingClientRect();
      let pct = ((x - rect.left) / rect.width) * 100;
      pct = Math.max(0, Math.min(100, pct));
      before.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
      handle.style.left = pct + '%';
    }

    slider.addEventListener('mousedown',  (e) => { isDragging = true; setPosition(e.clientX); });
    slider.addEventListener('touchstart', (e) => { isDragging = true; setPosition(e.touches[0].clientX); }, { passive: true });

    window.addEventListener('mousemove', (e) => { if (isDragging) setPosition(e.clientX); });
    window.addEventListener('touchmove', (e) => { if (isDragging) setPosition(e.touches[0].clientX); }, { passive: true });

    window.addEventListener('mouseup',  () => { isDragging = false; });
    window.addEventListener('touchend', () => { isDragging = false; });
  });
}

/* ── Carousel ──────────────────────────────────────────────── */
function initCarousels() {
  document.querySelectorAll('[data-carousel]').forEach(carousel => {
    const track    = carousel.querySelector('.carousel-track');
    const slides   = carousel.querySelectorAll('.carousel-slide');
    const prevBtn  = carousel.querySelector('.carousel-btn.prev');
    const nextBtn  = carousel.querySelector('.carousel-btn.next');
    const dotsWrap = carousel.querySelector('.carousel-dots');
    let current = 0;

    // Create dots
    slides.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.classList.add('carousel-dot');
      if (i === 0) dot.classList.add('active');
      dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
      dot.addEventListener('click', () => goTo(i));
      dotsWrap.appendChild(dot);
    });

    const dots = dotsWrap.querySelectorAll('.carousel-dot');

    function goTo(index) {
      current = ((index % slides.length) + slides.length) % slides.length;
      track.style.transform = `translateX(-${current * 100}%)`;
      dots.forEach((d, i) => d.classList.toggle('active', i === current));
    }

    prevBtn.addEventListener('click', () => goTo(current - 1));
    nextBtn.addEventListener('click', () => goTo(current + 1));

    // Touch swipe support
    let startX = 0;
    track.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    track.addEventListener('touchend', (e) => {
      const diff = startX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 50) {
        diff > 0 ? goTo(current + 1) : goTo(current - 1);
      }
    });

    // Keyboard support
    carousel.setAttribute('tabindex', '0');
    carousel.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft')  goTo(current - 1);
      if (e.key === 'ArrowRight') goTo(current + 1);
    });

    // Auto-advance (optional — uncomment to enable)
    // setInterval(() => goTo(current + 1), 5000);
  });
}

/* ── Copy BibTeX ───────────────────────────────────────────── */
function initCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copy;
      const target   = document.getElementById(targetId);
      if (!target) return;

      navigator.clipboard.writeText(target.textContent.trim()).then(() => {
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = original;
          btn.classList.remove('copied');
        }, 2000);
      });
    });
  });
}

/* ── Lazy-load videos on scroll ────────────────────────────── */
function initLazyVideos() {
  const videos = document.querySelectorAll('video[data-src]');
  if (!videos.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const video = entry.target;
        const source = video.querySelector('source');
        if (source && source.dataset.src) {
          source.src = source.dataset.src;
          video.load();
        }
        observer.unobserve(video);
      }
    });
  }, { rootMargin: '200px' });

  videos.forEach(v => observer.observe(v));
}

/* ── Lazy-load iframes on scroll ───────────────────────────── */
function initLazyIframes() {
  const iframes = document.querySelectorAll('iframe[data-src]');
  if (!iframes.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const iframe = entry.target;
        if (iframe.dataset.src) {
          iframe.src = iframe.dataset.src;
          iframe.removeAttribute('data-src');
          // Add loaded class for any CSS transitions
          iframe.addEventListener('load', () => {
            iframe.classList.add('lazy-loaded');
          }, { once: true });
        }
        observer.unobserve(iframe);
      }
    });
  }, { rootMargin: '300px' }); // Load slightly before coming into view

  iframes.forEach(iframe => observer.observe(iframe));
}

/* ── Dynamic TOC — right sidebar, rebuilt when content changes ── */
var _tocScrollHandler = null;

/* Short labels used in the TOC for each learning algorithm */
var _tocLpLabels = {
  bc:       'Behavior Cloning',
  rl:       'Reinforcement Learning',
  sim2real: 'Sim-to-Real Transfer'
};

function buildDynamicToc() {
  var nav = document.getElementById('dynamic-toc');
  if (!nav) return;

  var entries = [];

  /* ── 1. Always-present static entries ────────────────────── */
  entries.push({ id: 'abstract',  text: 'Abstract' });
  entries.push({ id: 'method',    text: 'Position Impedance Controllers & Gains' });
  entries.push({ id: 'poll',      text: 'Gain Tuning Practices & Pitfalls' });

  /* Sub-items for first poll — always shown, blurred until user picks */
  var pollChoice = localStorage.getItem('poll-choice');
  var choiceAll = ['a', 'b', 'c'];
  var choiceLabels = { a: 'Not Tuning', b: 'Tune based on Task', c: 'Tune for Teleop' };
  var pollDyn = document.getElementById('poll-dynamic-content');
  var pollHasContent = pollDyn && pollDyn.innerHTML.trim();

  if (pollHasContent) {
    var choiceOthers = choiceAll.filter(function(k) { return k !== pollChoice; });
    var choiceOrdered = pollChoice ? [pollChoice].concat(choiceOthers) : choiceAll;
    choiceOrdered.forEach(function(key) {
      var anchor = document.getElementById('results-' + key);
      if (anchor) {
        entries.push({ id: 'results-' + key, text: choiceLabels[key], sub: true });
      }
    });
  } else {
    /* No content yet — show placeholders blurred */
    choiceAll.forEach(function(key) {
      entries.push({ id: 'poll', text: choiceLabels[key], sub: true, blurred: true });
    });
  }

  /* ── 2. Learning section — always present, subs appear after poll-2 ── */
  var lpAnchorId = document.getElementById('learning-poll') ? 'learning-poll'
                 : document.getElementById('poll-dynamic-content') ? 'poll-dynamic-content'
                 : 'poll';
  entries.push({ id: lpAnchorId, text: 'How Gains Affect Learning Algorithms' });

  /* Learning sub-items — always shown, blurred until user picks */
  var lpContainer = document.querySelector('#lp-dynamic-content');
  var lpHasContent = lpContainer && lpContainer.innerHTML.trim();

  if (lpHasContent) {
    var lpChoice = localStorage.getItem('lp-choice');
    var allLp = ['bc', 'rl', 'sim2real'];
    var others = allLp.filter(function(k) { return k !== lpChoice; });
    var ordered = lpChoice ? [lpChoice].concat(others) : allLp;

    ordered.forEach(function(key) {
      var allH2 = lpContainer.querySelectorAll('h2');
      var idx = ordered.indexOf(key);
      var heading = allH2[idx];
      if (heading) {
        if (!heading.id) {
          heading.id = 'toc-lp-' + key;
        }
        entries.push({ id: heading.id, text: _tocLpLabels[key], sub: true });
      }
    });
  } else {
    /* No content yet — show placeholders blurred */
    var allLpKeys = ['bc', 'rl', 'sim2real'];
    allLpKeys.forEach(function(key) {
      entries.push({ id: lpAnchorId, text: _tocLpLabels[key], sub: true, blurred: true });
    });
  }

  /* ── 3. Citation ─────────────────────────────────────────── */
  entries.push({ id: 'citation', text: 'BibTeX' });

  /* ── Build HTML ──────────────────────────────────────────── */
  if (!entries.length) { nav.innerHTML = ''; return; }

  var html = '<span class="toc-title">Table of Contents</span><ul>';
  entries.forEach(function(e) {
    var classes = [];
    if (e.sub) classes.push('toc-sub');
    if (e.blurred) classes.push('toc-blurred');
    var cls = classes.length ? ' class="' + classes.join(' ') + '"' : '';
    html += '<li' + cls + '><a href="#' + e.id + '">' + e.text + '</a></li>';
  });
  html += '</ul>';
  nav.innerHTML = html;

  /* ── Scroll spy ──────────────────────────────────────────── */
  if (_tocScrollHandler) window.removeEventListener('scroll', _tocScrollHandler);

  /* Make TOC links smooth-scroll without changing the URL hash */
  nav.querySelectorAll('a').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      var targetId = this.getAttribute('href').slice(1);
      var target = document.getElementById(targetId);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  var tocLinks = nav.querySelectorAll('a');
  /* Only track non-blurred entries for scroll spy */
  var spyLinks = Array.from(tocLinks).filter(function(a) {
    return !a.closest('.toc-blurred');
  });
  var spyIds = spyLinks.map(function(a) { return a.getAttribute('href').slice(1); });
  var spySecs = spyIds.map(function(id) { return document.getElementById(id); }).filter(Boolean);

  function onScroll() {
    var scrollY = window.scrollY + window.innerHeight / 3;
    var currentId = spyIds[0];
    spySecs.forEach(function(sec) {
      var top = sec.getBoundingClientRect().top + window.scrollY;
      if (top <= scrollY) currentId = sec.id;
    });
    tocLinks.forEach(function(link) {
      var isBlurred = !!link.closest('.toc-blurred');
      link.classList.toggle('active', !isBlurred && link.getAttribute('href') === '#' + currentId);
    });
  }

  _tocScrollHandler = onScroll;
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ── Poll URL Hash Routing ──────────────────────────────────── */
function parsePollHash() {
  var h = location.hash.replace(/^#/, '');
  if (!h) return { choice: null, learn: null };
  var parts = h.split('/');
  return {
    choice: /^[a-c]$/.test(parts[0]) ? parts[0] : null,
    learn:  parts[1] && /^(bc|rl|sim2real)$/.test(parts[1]) ? parts[1] : null
  };
}

function updatePollHash(choice, learn) {
  var frag = '';
  if (choice) { frag = choice; if (learn) frag += '/' + learn; }
  var url = location.pathname + location.search + (frag ? '#' + frag : '');
  history.replaceState(null, '', url);
}

/* ── Gain-Tuning Poll ───────────────────────────────────────── */
function initPoll() {
  const cards = document.querySelectorAll('.poll-card[data-poll]');
  const responses = document.querySelectorAll('.poll-response');
  const dynamicContainer = document.getElementById('poll-dynamic-content');
  const optionsContainer = document.querySelector('.poll-options');
  const resetBtn = document.getElementById('poll-reset');
  if (!cards.length) return;

  // Cache fetched HTML fragments
  const contentCache = {};

  const CHOICE_ALL = ['a', 'b', 'c'];
  const CHOICE_ALSO_LABELS = {
    a: 'Some people don\u2019t tune gains at all. However...',
    b: 'Some people also tune gains based on the task. However...',
    c: 'Some people tune gains for the best teleop experience. However...'
  };

  async function fetchChoiceHtml(key) {
    if (contentCache[key]) return contentCache[key];
    const url = 'static/content/choice-' + key + '.html';
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const html = await res.text();
    contentCache[key] = html;
    return html;
  }

  /** Strip the learning-poll placeholder from content HTML
      (we only want ONE at the very end).
      Also rewrite id="results" to avoid duplicate IDs. */
  function prepareChoiceHtml(html, key) {
    html = html.replace(/<div class="learning-poll-placeholder"><\/div>/g, '');
    html = html.replace(/id="results"/g, 'id="results-' + key + '"');
    return html;
  }

  async function loadContent(choice) {
    if (!dynamicContainer) return;

    const others = CHOICE_ALL.filter(k => k !== choice);
    const ordered = [choice].concat(others);

    try {
      const htmls = await Promise.all(ordered.map(k => fetchChoiceHtml(k)));

      // Primary choice content
      let combined = prepareChoiceHtml(htmls[0], ordered[0]);

      // Non-selected choices with "also" labels
      for (let i = 1; i < ordered.length; i++) {
        const key = ordered[i];
        combined += '<div class="choice-also-label">'
          + CHOICE_ALSO_LABELS[key]
          + '</div>'
          + prepareChoiceHtml(htmls[i], key);
      }

      // Transition paragraph before learning-algorithm poll
      combined += '<section class="section" id="lp-transition">'
        + '<div class="container container-medium">'
        + '<h2>Gains should be tuned for your learning algorithm.</h2>'
        + '<p>'
        + 'So far we\'ve seen how the robotics community tunes controller gains — and the hidden costs of common defaults. '
        + 'But the story doesn\'t end with the controller. '
        + 'The <em>right</em> gain regime depends on how you train your policy: '
        + 'behavior cloning, reinforcement learning, and sim-to-real transfer each respond to gains very differently.'
        + '</p>'
        + '</div></section>';

      // One learning-poll placeholder at the very end
      combined += '<div class="learning-poll-placeholder"></div>';

      dynamicContainer.innerHTML = combined;
      reinitComponents();
    } catch (err) {
      console.warn('Failed to load content for choice ' + choice, err);
    }
  }

  // Re-init interactive components inside newly injected HTML
  async function reinitComponents() {
    initTabs();
    initComparisonSliders();
    initCarousels();
    initCopyButtons();
    initLazyVideos();
    initLazyIframes();
    await loadLearningPollIntoPlaceholders();
    initSimTabs();
    buildDynamicToc();
  }

  function applyChoice(choice, animate) {
    // Mark selected card
    cards.forEach(c => c.classList.remove('selected'));
    const selected = document.querySelector('.poll-card[data-poll="' + choice + '"]');
    if (selected) selected.classList.add('selected');

    // Stop pulse on all cards
    if (optionsContainer) optionsContainer.classList.add('has-selection');

    // Show reset button
    if (resetBtn) resetBtn.classList.add('visible');

    // Show matching response
    responses.forEach(r => r.classList.remove('visible'));
    const target = document.getElementById('poll-response-' + choice);
    if (target) {
      target.classList.add('visible');
      if (animate) {
        setTimeout(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
    }

    // Load the choice-specific content
    loadContent(choice);

    // Update URL hash (preserve learning choice if set)
    var hs = parsePollHash();
    updatePollHash(choice, hs.learn);

    // Show share button
    var shareBtn = document.getElementById('poll-share-btn');
    if (shareBtn) shareBtn.classList.add('visible');
  }

  function clearChoice() {
    localStorage.removeItem('poll-choice');
    localStorage.removeItem('lp-choice');
    updatePollHash(null, null);
    cards.forEach(c => c.classList.remove('selected'));
    responses.forEach(r => r.classList.remove('visible'));
    if (optionsContainer) optionsContainer.classList.remove('has-selection');
    if (resetBtn) resetBtn.classList.remove('visible');
    var shareBtn = document.getElementById('poll-share-btn');
    if (shareBtn) shareBtn.classList.remove('visible');
    if (dynamicContainer) dynamicContainer.innerHTML = '';
    buildDynamicToc();
  }

  // Priority: URL hash > localStorage
  var hashState = parsePollHash();
  var savedChoice = hashState.choice || localStorage.getItem('poll-choice');
  if (hashState.learn) localStorage.setItem('lp-choice', hashState.learn);
  if (savedChoice) {
    localStorage.setItem('poll-choice', savedChoice);
    applyChoice(savedChoice, false);
  }

  cards.forEach(card => {
    card.addEventListener('click', () => {
      const choice = card.getAttribute('data-poll');
      localStorage.setItem('poll-choice', choice);
      applyChoice(choice, true);
    });
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', clearChoice);
  }

  // Share / copy-link button
  var shareBtn = document.getElementById('poll-share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(location.href).then(() => {
        var orig = shareBtn.innerHTML;
        shareBtn.innerHTML = '<i class="fas fa-check"></i> Link copied!';
        shareBtn.classList.add('copied');
        setTimeout(() => { shareBtn.innerHTML = orig; shareBtn.classList.remove('copied'); }, 2000);
      });
    });
  }

  // React to browser back/forward changing the hash
  window.addEventListener('hashchange', () => {
    var h = location.hash.replace(/^#/, '');
    // Ignore non-poll hashes (e.g. #abstract, #method from TOC clicks)
    if (h && !/^[a-c](\/|$)/.test(h)) return;
    var hs = parsePollHash();
    if (hs.choice) {
      localStorage.setItem('poll-choice', hs.choice);
      if (hs.learn) localStorage.setItem('lp-choice', hs.learn);
      applyChoice(hs.choice, false);
    } else {
      clearChoice();
    }
  });
}

/* ── Sticky Header ─────────────────────────────────────────── */
function initStickyHeader() {
  const hero = document.querySelector('.hero');
  const sticky = document.getElementById('sticky-header');
  if (!hero || !sticky) return;

  function onScroll() {
    const heroBottom = hero.offsetTop + hero.offsetHeight;
    if (window.scrollY > heroBottom - 10) {
      sticky.classList.add('visible');
    } else {
      sticky.classList.remove('visible');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ── Info Modals ("How?" buttons) ──────────────────────────── */
function initInfoModals() {
  /* Delegate: works for dynamically injected content too */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.how-btn');
    if (btn) {
      const id = btn.dataset.modal;
      const overlay = document.getElementById(id);
      if (overlay) {
        overlay.classList.add('active');
        /* Re-render MathJax / KaTeX inside the modal if available */
        if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise([overlay]);
        if (window.renderMathInElement) renderMathInElement(overlay);
      }
      return;
    }

    /* Close on overlay background click */
    const overlay = e.target.closest('.info-modal-overlay');
    if (overlay && !e.target.closest('.info-modal')) {
      overlay.classList.remove('active');
    }

    /* Close on × button */
    if (e.target.closest('.info-modal-close')) {
      const modal = e.target.closest('.info-modal-overlay');
      if (modal) modal.classList.remove('active');
    }
  });

  /* Close on Escape */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.info-modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
  });
}

/* ── Learning-Algorithm Poll (shared, injected into choice pages) ── */
let _learningPollHtmlCache = null;

async function loadLearningPollIntoPlaceholders() {
  const placeholders = document.querySelectorAll('.learning-poll-placeholder');
  if (!placeholders.length) return;

  // Fetch once
  if (!_learningPollHtmlCache) {
    try {
      const res = await fetch('static/content/learning-poll.html');
      if (!res.ok) throw new Error(res.status);
      _learningPollHtmlCache = await res.text();
    } catch (err) {
      console.warn('Failed to load learning-poll.html', err);
      return;
    }
  }

  placeholders.forEach(ph => {
    if (ph.dataset.lpLoaded) return;          // already injected
    ph.innerHTML = _learningPollHtmlCache;
    ph.dataset.lpLoaded = '1';
  });

  // Restore saved choice if any
  const saved = localStorage.getItem('lp-choice');
  if (saved) {
    applyLpChoice(saved, false);
  } else {
    // Rebuild TOC now that #learning-poll exists in the DOM
    buildDynamicToc();
  }
}

function applyLpChoice(choice, animate) {
  // Save scroll position before making changes
  const savedScrollY = window.scrollY;

  const allCards = document.querySelectorAll('.lp-card');
  const allResponses = document.querySelectorAll('.lp-response');
  const allOptions = document.querySelectorAll('.lp-options');
  const allResets = document.querySelectorAll('.lp-reset');

  allCards.forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.lp-card[data-lp="' + choice + '"]')
    .forEach(c => c.classList.add('selected'));

  allOptions.forEach(o => o.classList.add('has-selection'));
  allResets.forEach(r => r.classList.add('visible'));

  allResponses.forEach(r => r.classList.remove('visible'));
  document.querySelectorAll('#lp-response-' + choice)
    .forEach(r => {
      r.classList.add('visible');
    });

  // Load sub-content
  loadLpContent(choice, savedScrollY);

  // Update URL hash (preserve gain choice)
  var hs = parsePollHash();
  updatePollHash(hs.choice, choice);

  window.scrollTo(0, savedScrollY);
}

const _lpContentCache = {};

const LP_ALL = ['bc', 'rl', 'sim2real'];
const LP_LABELS = {
  bc:       'Behavior Cloning',
  rl:       'Reinforcement Learning',
  sim2real: 'Sim-to-Real Transfer'
};
const LP_COLORS = {
  bc:       '#d97706',
  rl:       '#0d9488',
  sim2real: '#6366f1'
};

async function fetchLpHtml(key) {
  if (_lpContentCache[key]) return _lpContentCache[key];
  const url = 'static/content/learning-' + key + '.html';
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  const html = await res.text();
  _lpContentCache[key] = html;
  return html;
}

async function loadLpContent(choice, savedScrollY) {
  const containers = document.querySelectorAll('#lp-dynamic-content');
  if (!containers.length) return;

  const restoreScroll = () => {
    if (savedScrollY !== undefined) {
      window.scrollTo(0, savedScrollY);
    }
  };

  // Determine order: user's choice first, then the rest
  const others = LP_ALL.filter(k => k !== choice);
  const ordered = [choice].concat(others);

  // Fetch all three in parallel
  try {
    const htmls = await Promise.all(ordered.map(k => fetchLpHtml(k)));

    // Build combined HTML: primary choice as-is, others with a subtle label
    let combined = htmls[0];
    for (let i = 1; i < ordered.length; i++) {
      const key = ordered[i];
      combined += '<div class="lp-also-label">What if you relied on '
        + LP_LABELS[key] + '?'
        + '</div>'
        + htmls[i];
    }

    containers.forEach(c => { c.innerHTML = combined; });
    rerenderMath();
    initSimTabs();
    initViewerModeToggle();
    initPolicyGrid();
    initLazyIframes();
    buildDynamicToc();
    restoreScroll();
  } catch (err) {
    console.warn('Failed to load learning content for ' + choice, err);
  }
}

/** Initialise any .sim-tabs containers found in the DOM */
function initSimTabs() {
  document.querySelectorAll('.sim-tabs').forEach(root => {
    if (root._simTabsInit) return; // already wired up
    root._simTabsInit = true;

    const vp   = root.querySelector('.sim-tab-viewport');
    const btns = root.querySelectorAll('.sim-tab-btn');
    if (!vp || !btns.length) return;

    function loadScene(btn) {
      vp.innerHTML = '';
      const scene = btn.dataset.scene;
      const traj  = btn.dataset.traj;
      const iframe = document.createElement('iframe');
      if (traj) {
        iframe.src = 'static/assets/mujoco_trajectory.html?scene=' + scene + '&traj=' + traj;
      } else {
        iframe.src = 'static/assets/mujoco_scene.html?scene=' + scene;
      }
      vp.appendChild(iframe);
    }

    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadScene(btn);
      });
    });

    // Auto-load the first (active) tab
    const first = root.querySelector('.sim-tab-btn.active') || btns[0];
    loadScene(first);
  });
}

/* ── Viewer Mode Toggle (Dataset / Policy) ── */
function initViewerModeToggle() {
  const toggle = document.getElementById('viewer-mode-toggle');
  if (!toggle || toggle._vmtInit) return;
  toggle._vmtInit = true;

  const datasetPanel = document.getElementById('dataset-panel');
  const policyPanel = document.getElementById('policy-panel');
  const btns = toggle.querySelectorAll('.vmt-btn');

  if (!datasetPanel || !policyPanel || !btns.length) return;

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (mode === 'dataset') {
        datasetPanel.classList.remove('hidden');
        policyPanel.classList.add('hidden');
      } else {
        datasetPanel.classList.add('hidden');
        policyPanel.classList.remove('hidden');
        // Initialize policy grid if switching to policy mode
        initPolicyGrid();
        // Trigger redraw after panel is visible
        requestAnimationFrame(() => {
          const canvas = document.getElementById('pgw-canvas');
          if (canvas && canvas._redraw) canvas._redraw();
        });
      }
    });
  });
}

/* ── Policy Grid Widget (clickable Kp/Kd grid → policy iframe) ── */
function initPolicyGrid() {
  const widget = document.getElementById('bc-policy-grid');
  if (!widget || widget._pgwInit) return;
  widget._pgwInit = true;

  const canvas      = document.getElementById('pgw-canvas');
  const iframe      = document.getElementById('pgw-iframe');
  const placeholder = document.getElementById('pgw-placeholder');
  const kpValEl     = document.getElementById('pgw-kp-val');
  const kdValEl     = document.getElementById('pgw-kd-val');
  const taskTabs    = document.getElementById('pgw-task-tabs');
  if (!canvas || !iframe) return;

  // Task configurations: { scene, base, dots, defaultDot }
  const TASKS = {
    dishwasher: {
      scene: 'xmls/franka_emika_panda/scene_dishwasher_open.xml',
      base: 'models/dishwasher_open_2f85',
      dots: [
        { kp: 32,   kd: 2,   folder: 'K32D2M10',     nx: 0, ny: 0 },
        { kp: 1024, kd: 2,   folder: 'K1024D2M10',   nx: 1, ny: 0 },
        { kp: 32,   kd: 128, folder: 'K32D128M10',   nx: 0, ny: 1 },
        { kp: 1024, kd: 128, folder: 'K1024D128M10', nx: 1, ny: 1 },
      ],
      defaultDot: 2  // K32D128 (compliant + damped)
    },
    handover: {
      scene: 'xmls/scene_handover.xml',
      base: 'models/handover_dual_franka_2f85',
      dots: [
        { kp: 64,   kd: 2,  folder: 'K64D2M10',    nx: 0, ny: 0 },
        { kp: 1024, kd: 2,  folder: 'K1024D2M10',  nx: 1, ny: 0 },
        { kp: 64,   kd: 32, folder: 'K64D32M10',   nx: 0, ny: 1 },
        { kp: 1024, kd: 64, folder: 'K1024D64M10', nx: 1, ny: 1 },
      ],
      defaultDot: 2  // K64D32 (compliant + damped)
    }
  };

  let currentTask = 'dishwasher';
  let DOTS = TASKS[currentTask].dots;

  // Corner colors matching the trajectory viewer palette
  const GC_A = [140,140,140]; // low Kp, low Kd (bottom-left)
  const GC_B = [76,114,176];  // high Kp, low Kd (bottom-right)
  const GC_C = [196,78,82];   // low Kp, high Kd (top-left)
  const GC_D = [129,114,178]; // high Kp, high Kd (top-right)

  function lerpC(a, b, t) {
    return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
  }
  function dotColor(nx, ny) {
    const c = lerpC(lerpC(GC_A, GC_B, nx), lerpC(GC_C, GC_D, nx), ny);
    return `rgb(${c.map(Math.round).join(',')})`;
  }

  let activeIdx = -1;

  // Padding & layout helpers
  const PAD_BOT = 18, PAD_LEFT = 18, PAD_TOP = 22, PAD_RIGHT = 18;

  function gridMetrics(S) {
    const gs = Math.min(S - PAD_LEFT - PAD_RIGHT, S - PAD_TOP - PAD_BOT);
    return { gs, ox: PAD_LEFT, oy: PAD_TOP };
  }

  function dotXY(d, S) {
    const { gs, ox, oy } = gridMetrics(S);
    // Place dots 1 cell in from edges on a 6x6 grid
    const cellNx = (1 + d.nx * 4) / 6;  // 1/6 or 5/6
    const cellNy = (1 + d.ny * 4) / 6;
    return {
      cx: ox + cellNx * gs,
      cy: oy + (1 - cellNy) * gs
    };
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const S = canvas.clientWidth;
    if (S === 0) return;
    canvas.width  = S * dpr;
    canvas.height = S * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const { gs, ox, oy } = gridMetrics(S);
    ctx.clearRect(0, 0, S, S);

    // 6x6 grid lines
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
      const f = i / 6;
      ctx.beginPath(); ctx.moveTo(ox + f * gs, oy);      ctx.lineTo(ox + f * gs, oy + gs); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox, oy + f * gs);      ctx.lineTo(ox + gs, oy + f * gs); ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ox, oy + gs); ctx.lineTo(ox + gs + 4, oy + gs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, oy + gs); ctx.lineTo(ox, oy - 4); ctx.stroke();

    // Axis labels
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('kp \u2192', ox + gs / 2, S - 2);
    ctx.save();
    ctx.translate(ox / 2, oy + gs / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText('kd \u2192', 0, 0);
    ctx.restore();

    // Dots
    const R_IDLE = 9, R_ACTIVE = 11;
    DOTS.forEach((d, i) => {
      const { cx, cy } = dotXY(d, S);
      const r = i === activeIdx ? R_ACTIVE : R_IDLE;

      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = dotColor(d.nx, d.ny);
      ctx.fill();

      if (i === activeIdx) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      }
      ctx.stroke();
    });
  }

  // Expose redraw for external triggering
  canvas._redraw = draw;

  let iframeLoaded = false; // true once the first full iframe load is done
  let currentScene = null;  // track loaded scene to detect task switches

  function selectDot(idx) {
    if (idx === activeIdx && currentScene === TASKS[currentTask].scene) return;
    activeIdx = idx;
    const task = TASKS[currentTask];
    const d = DOTS[idx];
    kpValEl.textContent = d.kp;
    kdValEl.textContent = d.kd;
    placeholder.classList.add('hidden');

    const policyUrl = task.base + '/' + d.folder + '/policy.onnx';
    const configUrl = task.base + '/' + d.folder + '/policy_config.json';

    if (!iframeLoaded || currentScene !== task.scene) {
      // First time or task changed: load the full iframe (scene + policy)
      iframe.src = 'static/assets/mujoco_policy.html?scene=' + task.scene
        + '&policy=' + policyUrl + '&config=' + configUrl + '&autorun=1';
      iframeLoaded = true;
      currentScene = task.scene;
    } else {
      // Same task: just swap the policy via postMessage (with autorun)
      iframe.contentWindow.postMessage({
        type: 'load-policy',
        policy: policyUrl,
        config: configUrl,
        autorun: true
      }, '*');
    }
    draw();
  }

  function switchTask(taskName) {
    if (taskName === currentTask) return;
    currentTask = taskName;
    DOTS = TASKS[currentTask].dots;
    activeIdx = -1;  // reset selection
    draw();
    selectDot(TASKS[currentTask].defaultDot);
  }

  // Hit test
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const S = canvas.clientWidth;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let best = -1, bestDist = Infinity;
    DOTS.forEach((d, i) => {
      const { cx, cy } = dotXY(d, S);
      const dist = Math.hypot(mx - cx, my - cy);
      if (dist < 22 && dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best >= 0) selectDot(best);
  });

  // Cursor feedback
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const S = canvas.clientWidth;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let hover = false;
    DOTS.forEach((d) => {
      const { cx, cy } = dotXY(d, S);
      if (Math.hypot(mx - cx, my - cy) < 22) hover = true;
    });
    canvas.style.cursor = hover ? 'pointer' : 'default';
  });

  // Task tab click handlers
  if (taskTabs) {
    taskTabs.querySelectorAll('.pgw-task-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        taskTabs.querySelectorAll('.pgw-task-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        switchTask(btn.dataset.task);
      });
    });
  }

  // Auto-select the best-performing gain for initial task
  draw();
  selectDot(TASKS[currentTask].defaultDot);
}

function clearLpChoice() {
  localStorage.removeItem('lp-choice');
  var hs = parsePollHash();
  updatePollHash(hs.choice, null);
  document.querySelectorAll('.lp-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.lp-response').forEach(r => r.classList.remove('visible'));
  document.querySelectorAll('.lp-options').forEach(o => o.classList.remove('has-selection'));
  document.querySelectorAll('.lp-reset').forEach(r => r.classList.remove('visible'));
  document.querySelectorAll('#lp-dynamic-content').forEach(c => { c.innerHTML = ''; });
  buildDynamicToc();
}

function rerenderMath() {
  if (window.renderMathInElement) renderMathInElement(document.body, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false }
    ]
  });
  if (window.MathJax && MathJax.typesetPromise) MathJax.typesetPromise();
}

/* Delegated click handlers for the learning poll */
document.addEventListener('click', (e) => {
  const card = e.target.closest('.lp-card');
  if (card) {
    const choice = card.dataset.lp;
    localStorage.setItem('lp-choice', choice);
    applyLpChoice(choice, true);
    return;
  }

  if (e.target.closest('.lp-reset')) {
    clearLpChoice();
  }
});
