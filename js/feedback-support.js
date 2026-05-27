// =============================================
// PITCORNER — Feedback & Support System
// Interactive modals for user feedback and developer tips
// =============================================

import { $ } from './utils.js';

let overlay = null;
let activeRating = 0;

// Safe static configurations for public-safe endpoints
// PitCorner utilizes a private Cloudflare Worker API at https://api.pitcorner.com/feedback
// to securely forward feedback emails without exposing private email credentials or keys.
const FEEDBACK_CONFIG = {
  // Your custom Cloudflare Worker endpoint (or local mock in dev)
  apiUrl: window.PITCORNER_FEEDBACK_API_URL || 'https://api.pitcorner.com/feedback',
  // Legacy Formspree token fallback (set to '' or a token)
  formspreeId: window.PITCORNER_FEEDBACK_FORMSPREE_ID || ''
};

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.getElementById('feedback-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'driver-modal-overlay';
    overlay.id = 'feedback-modal-overlay';
    overlay.innerHTML = '<div class="driver-modal" id="feedback-modal" style="max-width: 580px; box-shadow: var(--shadow-glow);"></div>';
    document.body.appendChild(overlay);
  }

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Close on Escape key press
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
  });

  return overlay;
}

function closeModal() {
  if (overlay) {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
}

/**
 * Launch the Support Me brand selection modal
 */
export function showSupportModal() {
  ensureOverlay();
  const modal = document.getElementById('feedback-modal');
  modal.innerHTML = `
    <button class="driver-modal-close" id="fbm-close" aria-label="Close">✕</button>
    <div style="padding: var(--space-2xl) var(--space-lg); text-align: center; font-family:'Outfit', sans-serif; position: relative; z-index: 5;">
      <div class="success-checkmark-circle" style="background: rgba(225, 6, 0, 0.08); border-color: var(--f1-red); color: var(--f1-red); margin: 0 auto 20px auto; box-shadow: 0 0 25px rgba(225, 6, 0, 0.15);">
        <i class="fa-solid fa-mug-hot"></i>
      </div>
      <h2 style="font-weight: 800; font-size: 1.6rem; color: var(--text-primary); margin-bottom: 12px;">Support PitCorner</h2>
      <p style="font-size: 0.88rem; color: var(--text-secondary); max-width: 420px; margin: 0 auto 16px auto; line-height: 1.6;">
        PitCorner is completely free and always will be. If you're enjoying it and feel like buying me a coffee, it genuinely means the world.
      </p>
      <p style="font-size: 0.78rem; color: var(--text-muted); max-width: 380px; margin: 0 auto 24px auto; line-height: 1.5;">
        No pressure at all — using the app and sharing it with fellow fans is more than enough. 🏁
      </p>
      <a href="https://ko-fi.com/professorstankleton" target="_blank" rel="noopener noreferrer" id="fbm-kofi-btn" class="feedback-submit-btn" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; margin-top: 6px;">
        <i class="fa-solid fa-mug-hot"></i> Buy Me a Coffee on Ko-fi
      </a>
    </div>
  `;

  document.getElementById('fbm-close').addEventListener('click', closeModal);
  document.getElementById('fbm-kofi-btn').addEventListener('click', () => {
    showSupportToast('Ko-fi');
    setTimeout(() => closeModal(), 600);
  });

  document.body.style.overflow = 'hidden';
  overlay.classList.add('open');
}

/**
 * Launch the Send Feedback interactive form modal
 */
export function showFeedbackModal() {
  ensureOverlay();
  const modal = document.getElementById('feedback-modal');
  activeRating = 0;

  modal.innerHTML = `
    <button class="driver-modal-close" id="fbm-close" aria-label="Close">✕</button>
    <div style="padding: var(--space-xl) var(--space-lg); font-family:'Outfit', sans-serif; position: relative; z-index: 5;">
      <h2 style="font-weight: 800; font-size: 1.5rem; color: var(--text-primary); margin-bottom: 4px; display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-comments" style="color: var(--f1-red);"></i> Send Feedback
      </h2>
      <p style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 20px;">
        Have a feature suggestion, caught a bug, or just want to tell us what you think? We'd love to hear from you!
      </p>

      <form id="feedback-form" class="feedback-form">
        <div class="feedback-group">
          <label class="feedback-label">Rating</label>
          <div class="rating-stars" id="feedback-stars">
            <i class="fa-regular fa-star rating-star" data-rating="1"></i>
            <i class="fa-regular fa-star rating-star" data-rating="2"></i>
            <i class="fa-regular fa-star rating-star" data-rating="3"></i>
            <i class="fa-regular fa-star rating-star" data-rating="4"></i>
            <i class="fa-regular fa-star rating-star" data-rating="5"></i>
          </div>
        </div>

        <div class="feedback-group">
          <label class="feedback-label" for="fb-category">Category</label>
          <select id="fb-category" class="feedback-select" required>
            <option value="Bug">Bug Report</option>
            <option value="Feature" selected>Feature Request</option>
            <option value="UIUX">UI/UX Refinement</option>
            <option value="Praise">General Praise</option>
          </select>
        </div>

        <div class="feedback-group">
          <label class="feedback-label" for="fb-message">Message</label>
          <textarea id="fb-message" class="feedback-textarea" placeholder="Tell us more details..." required></textarea>
        </div>

        <button type="submit" class="feedback-submit-btn">
          <i class="fa-solid fa-paper-plane"></i> Submit Feedback
        </button>
      </form>
    </div>
  `;

  document.getElementById('fbm-close').addEventListener('click', closeModal);

  // Wire Star Rating Interaction
  const starsContainer = document.getElementById('feedback-stars');
  const stars = Array.from(starsContainer.querySelectorAll('.rating-star'));

  stars.forEach(star => {
    // Highlight stars on hover
    star.addEventListener('mouseenter', () => {
      const rating = parseInt(star.dataset.rating);
      highlightStars(stars, rating);
    });

    // Reset highlight on mouseleave (revert to clicked state)
    star.addEventListener('mouseleave', () => {
      highlightStars(stars, activeRating);
    });

    // Lock rating on click
    star.addEventListener('click', () => {
      activeRating = parseInt(star.dataset.rating);
      highlightStars(stars, activeRating);
    });
  });

  // Wire form submission
  const form = document.getElementById('feedback-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = document.getElementById('fb-category').value;
    const message = document.getElementById('fb-message').value.trim();

    if (!message) return;

    // Show submitting state on the button to prevent duplicate clicks
    const submitBtn = form.querySelector('.feedback-submit-btn');
    const originalBtnHtml = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="margin-right: 6px;"></i>Sending...';

    const payload = {
      rating: activeRating || 'No rating',
      category: category,
      message: message
    };

    let sentSuccessfully = true;
    const isProdApi = FEEDBACK_CONFIG.apiUrl && !FEEDBACK_CONFIG.apiUrl.includes('localhost') && FEEDBACK_CONFIG.apiUrl !== 'https://api.pitcorner.com/feedback';

    if (FEEDBACK_CONFIG.apiUrl && (isProdApi || !FEEDBACK_CONFIG.formspreeId)) {
      // Send securely to your custom Cloudflare Worker API
      try {
        const response = await fetch(FEEDBACK_CONFIG.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(`Cloudflare Worker returned status: ${response.status}`);
        }
      } catch (err) {
        console.error('[Feedback] Cloudflare Worker submission failed:', err);
        sentSuccessfully = false;
      }
    } else if (FEEDBACK_CONFIG.formspreeId) {
      // Send asynchronously to Formspree fallback
      try {
        const response = await fetch(`https://formspree.io/f/${FEEDBACK_CONFIG.formspreeId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(`Formspree returned status: ${response.status}`);
        }
      } catch (err) {
        console.error('[Feedback] Formspree fallback submission failed:', err);
        sentSuccessfully = false;
      }
    } else {
      // Safe development fallback: log mock submission to console and LocalStorage
      console.log('[Feedback Mock Submission] (Configure apiUrl in FEEDBACK_CONFIG):', payload);
      const mockList = JSON.parse(localStorage.getItem('pitcorner_feedback') || '[]');
      mockList.push({ timestamp: new Date().toISOString(), ...payload });
      localStorage.setItem('pitcorner_feedback', JSON.stringify(mockList));
    }

    if (sentSuccessfully) {
      // Transition form to success animation!
      modal.innerHTML = `
        <div class="feedback-success-overlay">
          <div class="success-checkmark-circle">
            <i class="fa-solid fa-check"></i>
          </div>
          <h2 style="font-family:'Outfit', sans-serif; font-weight: 800; font-size: 1.5rem; color: var(--text-primary); margin-bottom: 8px;">Feedback Submitted!</h2>
          <p style="font-size: 0.85rem; color: var(--text-secondary); max-width: 340px; line-height: 1.5; margin: 0 auto;">
            Thank you for helping us refine PitCorner! We read every single bug report and feature request to build the ultimate dashboard.
          </p>
        </div>
      `;

      // Auto-close after 2.5 seconds
      setTimeout(() => {
        closeModal();
      }, 2500);
    } else {
      // Graceful error recovery: restore button so user can retry
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnHtml;
      alert('Failed to transmit feedback. Please check your internet connection or try again later.');
    }
  });

  document.body.style.overflow = 'hidden';
  overlay.classList.add('open');
}

/**
 * Color stars dynamically based on ratings selection
 */
function highlightStars(stars, rating) {
  stars.forEach(s => {
    const sRating = parseInt(s.dataset.rating);
    if (sRating <= rating) {
      s.classList.remove('fa-regular');
      s.classList.add('fa-solid', 'active');
    } else {
      s.classList.remove('fa-solid', 'active');
      s.classList.add('fa-regular');
    }
  });
}

/**
 * Show a sleek carbon-fiber heart notification toast when clicking a support card
 */
function showSupportToast(platform) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(50px);
    background: rgba(20, 20, 32, 0.95);
    border: 1px solid var(--border-accent);
    box-shadow: var(--shadow-glow);
    padding: 12px 24px;
    border-radius: 100px;
    color: var(--text-primary);
    font-family: 'Outfit', sans-serif;
    font-size: 0.82rem;
    font-weight: 600;
    z-index: 3000;
    opacity: 0;
    transition: all 400ms var(--ease-out);
    display: flex;
    align-items: center;
    gap: 8px;
    pointer-events: none;
  `;
  toast.innerHTML = `<i class="fa-solid fa-heart" style="color: var(--f1-red); animation: pulse 1.5s infinite;"></i> Thank you! Redirecting to ${platform}...`;
  document.body.appendChild(toast);

  // Transition in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });

  // Transition out and clean up
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

/**
 * Launch the Changelog interactive scrollable timeline modal
 */
export function showChangelogModal() {
  ensureOverlay();
  const modal = document.getElementById('feedback-modal');
  modal.innerHTML = `
    <button class="driver-modal-close" id="fbm-close" aria-label="Close">✕</button>
    <div style="padding: var(--space-xl) var(--space-lg); font-family:'Outfit', sans-serif; position: relative; z-index: 5; max-height: 80vh; display: flex; flex-direction: column;">
      <h2 style="font-weight: 800; font-size: 1.5rem; color: var(--text-primary); margin-bottom: 4px; display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-clock-rotate-left" style="color: var(--f1-red);"></i> PitCorner Changelog
      </h2>
      <p style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 16px;">
        Follow our development journey as we build the ultimate, high-speed Formula 1 stats and analytics dashboard.
      </p>

      <div style="flex: 1; overflow-y: auto; padding-right: 8px;" class="custom-scrollbar">
        <div class="changelog-timeline">
          
          <!-- v1.1.1 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.1.1 <span>Active</span></div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag improved">Telemetry</span>
                <span>Switched from raw crossing calculations to querying OpenF1's official <code>/session_result</code> API endpoint.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Programmatically resolved all post-race administrative time penalties and DSQs.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Resolved fractional values (.7, .3) on points chart Y-axis, displaying clean whole integers.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">UI/UX</span>
                <span>Grouped weekend sessions by meeting, combining Saturday Sprints and Sunday GPs into one timeline round.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved" style="background: rgba(155, 89, 182, 0.12); border-color: rgba(155, 89, 182, 0.25); color: #9b59b6;">PWA</span>
                <span>Upgraded Service Worker cache (v3) to bundle and cache local PWA launch icons offline.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Performance</span>
                <span>Reduced initial database loading network overhead by querying unified results rather than parsing full lap history logs.</span>
              </li>
            </ul>
          </div>

          <!-- v1.1.0 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.1.0</div>
              <div class="changelog-date">May 26, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added" style="background: rgba(155, 89, 182, 0.12); border-color: rgba(155, 89, 182, 0.25); color: #9b59b6;">PWA</span>
                <span>Fully installable Progressive Web App (PWA) with manifest configuration and vector maskable icons.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added" style="background: rgba(155, 89, 182, 0.12); border-color: rgba(155, 89, 182, 0.25); color: #9b59b6;">PWA</span>
                <span>Active Service Worker (<code>sw.js</code>) caching static assets (HTML, CSS, JS) for instant off-line startup.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Added physical PNG icon formats to resolve shortcut creation issues on Android browsers.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Branding</span>
                <span>Unified global renaming to <strong>PitCorner</strong> to secure a legally-safe custom brand name.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">UI/UX</span>
                <span>Added top fixed API loading notification banner with sweeps, dismiss trigger, and animated progress indicator.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">UI/UX</span>
                <span>Added floating glassmorphic Back-to-Top scroll action button in the bottom-right corner.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Resolved race detail crashes due to missing <code>buildDriverMap</code> and <code>getPointsForPosition</code> imports.</span>
              </li>
            </ul>
          </div>

          <!-- v1.0.0 (Official Launch) -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.0.0 🏁 <span>Official Launch</span></div>
              <div class="changelog-date">May 25, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">UI/UX</span>
                <span>First public release! Upgraded F1 flags to clean SVG vector graphics using Flagcdn.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Icons</span>
                <span>Polished visual details across the app using solid, regular, and brand icons from Font Awesome 6.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Star-rating Feedback Form modal with categories and post-submit checkmark animations.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Support Me Coffee Modal with direct links to custom Ko-fi funding accounts.</span>
              </li>
            </ul>
          </div>

          <!-- v0.5.0 (Beta) -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v0.5.0 <span>Beta</span></div>
              <div class="changelog-date">May 12, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Driver Head-to-Head (H2H) comparison tool featuring interactive teammates battles and comparison charts.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Driver Profile highlights and Constructor details overlays showing career summaries and lineups.</span>
              </li>
            </ul>
          </div>

          <!-- v0.4.0 (Beta) -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v0.4.0 <span>Beta</span></div>
              <div class="changelog-date">May 2, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Charts</span>
                <span>Custom canvas-based Position History grid and lap-by-lap interval charts.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Performance</span>
                <span>Refined lazy-rendering logic to defer heavy chart loads until user expands the Race Deep-Dive tab.</span>
              </li>
            </ul>
          </div>

          <!-- v0.3.0 (Beta) -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v0.3.0 <span>Beta</span></div>
              <div class="changelog-date">April 19, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag improved">Caching</span>
                <span>Implemented local cache persistence engine utilizing browser LocalStorage and dynamic time-to-live logic.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">API</span>
                <span>Structured batch request fetches to query API endpoints in parallel, slashing startup times by over 60%.</span>
              </li>
            </ul>
          </div>

          <!-- v0.2.0 (Beta) -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v0.2.0 <span>Beta</span></div>
              <div class="changelog-date">April 3, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Integrated dynamic year selector support with pre-loaded historical F1 calendar database from 2023 to 2025.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag security">Security</span>
                <span>Added developer sandboxed offline mock data pipelines to prevent running out of live API rate limits during development.</span>
              </li>
            </ul>
          </div>

          <!-- v0.1.0 (Alpha) -->
          <div class="changelog-card" style="margin-bottom: 8px;">
            <div class="changelog-header">
              <div class="changelog-version">v0.1.0 <span>Alpha</span></div>
              <div class="changelog-date">March 20, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Initial Alpha Build! Standardized dark carbon-fiber design system frames, standings layouts, and initial OpenF1 hook.</span>
              </li>
            </ul>
          </div>

        </div>
      </div>
    </div>
  `;

  document.getElementById('fbm-close').addEventListener('click', closeModal);
  document.body.style.overflow = 'hidden';
  overlay.classList.add('open');
}

/**
 * Wire the feedback and support links and buttons globally
 */
export function initFeedbackSupport() {
  const navClBtn = document.getElementById('nav-changelog-btn');
  const footerClBtn = document.getElementById('footer-changelog-btn');
  const footerFbBtn = document.getElementById('footer-feedback-btn');
  const footerSpBtn = document.getElementById('footer-support-btn');

  const triggerChangelog = () => showChangelogModal();

  if (navClBtn) {
    navClBtn.addEventListener('click', triggerChangelog);
  }

  if (footerClBtn) {
    footerClBtn.addEventListener('click', triggerChangelog);
  }

  if (footerFbBtn) {
    footerFbBtn.addEventListener('click', () => {
      showFeedbackModal();
    });
  }

  if (footerSpBtn) {
    footerSpBtn.addEventListener('click', () => {
      showSupportModal();
    });
  }
}
