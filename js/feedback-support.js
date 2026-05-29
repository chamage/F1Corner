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
          <label class="feedback-label">Rating <span style="color:var(--f1-red);">*</span></label>
          <div class="rating-stars" id="feedback-stars">
            <i class="fa-regular fa-star rating-star" data-rating="1"></i>
            <i class="fa-regular fa-star rating-star" data-rating="2"></i>
            <i class="fa-regular fa-star rating-star" data-rating="3"></i>
            <i class="fa-regular fa-star rating-star" data-rating="4"></i>
            <i class="fa-regular fa-star rating-star" data-rating="5"></i>
          </div>
          <div id="fb-rating-error" style="color:var(--f1-red);font-size:0.75rem;margin-top:2px;display:none;font-weight:600;"><i class="fa-solid fa-circle-exclamation"></i> Please select a star rating.</div>
        </div>

        <div class="feedback-group">
          <label class="feedback-label" for="fb-category">Category <span style="color:var(--f1-red);">*</span></label>
          <select id="fb-category" class="feedback-select" required>
            <option value="">Select a category...</option>
            <option value="Bug">Bug Report</option>
            <option value="Feature">Feature Request</option>
            <option value="UIUX">UI/UX Refinement</option>
            <option value="Praise">General Praise</option>
          </select>
        </div>

        <div class="feedback-group">
          <label class="feedback-label" for="fb-message">Message <span style="color:var(--f1-red);">*</span></label>
          <textarea id="fb-message" class="feedback-textarea" placeholder="Tell us more details..." required></textarea>
        </div>

        <div class="feedback-group">
          <label class="feedback-label" for="fb-email">Email Address <span style="color:var(--text-muted);text-transform:none;font-size:0.7rem;font-weight:normal;">(Optional — for follow-ups)</span></label>
          <input type="email" id="fb-email" class="feedback-input" placeholder="name@example.com">
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
      const ratingErr = document.getElementById('fb-rating-error');
      if (ratingErr) ratingErr.style.display = 'none';
    });
  });

  // Wire form submission
  const form = document.getElementById('feedback-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Validate star rating selection
    if (activeRating === 0) {
      const ratingErr = document.getElementById('fb-rating-error');
      if (ratingErr) ratingErr.style.display = 'block';
      return;
    }

    const category = document.getElementById('fb-category').value;
    const message = document.getElementById('fb-message').value.trim();
    const email = document.getElementById('fb-email').value.trim();

    if (!category || !message) return;

    // Show submitting state on the button to prevent duplicate clicks
    const submitBtn = form.querySelector('.feedback-submit-btn');
    const originalBtnHtml = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="margin-right: 6px;"></i>Sending...';

    const payload = {
      rating: activeRating,
      category: category,
      message: message,
      email: email || undefined
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
          
          <!-- v1.5.0 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.5.0 <span class="new-badge" style="background: rgba(46, 204, 113, 0.15); border-color: rgba(46, 204, 113, 0.25); color: #2ecc71;">Active</span></div>
              <div class="changelog-date">May 29, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">New</span>
                <span>Decade Cockpit Season Picker Modal: Implemented a highly premium, visual decade-grouped year chip selector overlay modal, restoring modern season exploration from 2023 to 2026.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">New</span>
                <span>Tactile Scrolling Session Pills: Coded horizontal button pills (FP1, FP2, FP3, Quali, Race) inside race weekend detail pages to seamlessly toggle between sessions, replacing the browser dropdown.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Full-Color Flag & Card Backgrounds: Restored beautiful full-color country flag calendar card backdrops with high-brightness animations on completed races and custom vector circuit contours.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Standings Points Duplication: Completely resolved duplicate Sprint points double-counting by segregating GP races and Sprints at the database fetch layer.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Fail-Safe Placeholders & Queue Delays: Integrated is_incomplete: true localStorage caching placeholders for slow sessions and spaced sequential queue delay to 450ms, resolving rate limits.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>2026 Madrid/Barcelona Map Swap & 2025 Sprints 404: Mapped the correct circuit image overlays for 2026 Spanish & Barcelona GPs, and resolved 2025 Sprint session filter errors.</span>
              </li>
            </ul>
          </div>
          
          <!-- v1.4.0 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.4.0</div>
              <div class="changelog-date">May 28, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Safeguarded API Telemetry Cache: Prevented temporary empty OpenF1 API responses from being cached immutably as complete, allowing PitCorner to recover from rate-limiting outages automatically.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Preliminary Championship Decoupling: Prevented standings calculation engines from prematurely or incorrectly declaring World Champion clinician titles when viewing fast-path cached data or in cases of network-interrupted page loads.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Live Loading Banner Sync: Integrated seamless UI loading banner state changes, notifying the user when syncing background telemetry or experiencing network-related partial-data loads.</span>
              </li>
            </ul>
          </div>

          <!-- v1.3.3 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.3.3</div>
              <div class="changelog-date">May 28, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Qualifying & Practice DNS Inclusion: Ensured registered drivers who did not set a time in qualifying or practice are now fully listed in session results tables as DNS (with 0 laps completed) rather than being completely omitted, resolving season-long qualifying count discrepancies in driver profiles.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Sprint Tab Section Reordering: Reorganized the layout of the driver profile Sprint tab to match the Grand Prix tab ordering — displaying Sprint Qualifying Performance immediately below the primary stats grid, followed by the Sprint Results chart and Sprint Consistency gauges.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Sprint Standing Segregation & Crashes: Cleanly segregated Sprint Qualifying statistics from standard Grand Prix qualifying averages inside driver profiles, and resolved a TypeError standing crash on page startup.</span>
              </li>
            </ul>
          </div>

          <!-- v1.3.2 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.3.2</div>
              <div class="changelog-date">May 28, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">New</span>
                <span>Collapsible Laps & Sector Times accordion: Click any driver row to open a deep-dive modal detailing all individual sector times, personal bests, and tyre compound timeline stints.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">New</span>
                <span>Qualifying Segment Tags (Q1/Q2/Q3): Precise segment tags next to lap times in driver deep-dives and compiled season-long GP & Sprint Q3 appearances rates.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">New</span>
                <span>Qualifying Performance stats: Full season driver profile modals now feature a dedicated section displaying average grid positions and best qualifying results.</span>
              </li>
            </ul>
          </div>

          <!-- v1.3.0 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.3.0</div>
              <div class="changelog-date">May 28, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">New</span>
                <span>All Weekend Sessions: Browse Practice (FP1, FP2, FP3), Qualifying, Sprint Qualifying, Sprint, and Race results for completed weekends, sorted by fastest lap with gap-to-P1 deltas.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">New</span>
                <span>Segmented Qualifying Results: Automated Q1, Q2, and Q3 elimination segmented tables with driver elimination rankings.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Session-Aware Navigation: Session tabs (Overtakes, Positions) automatically show/hide based on session context, with a sleek full-width selector pill bar.</span>
              </li>
            </ul>
          </div>

          <!-- v1.2.2 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.2.2</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Eliminated Page-Level Auto-Scrolling: Completely removed annoying window-level scrolling on load and card select.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Collapsible Championship Leader History: Refined the dashboard's Points Tracker card by collapsing the Championship Leader History timeline by default, keeping page layouts extremely clean while adding a sleek, chevron-animated toggle button to show or hide the leadership runs.</span>
              </li>
            </ul>
          </div>

          <!-- v1.2.1 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.2.1</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Advanced F5 Reload Cache-Bust: Programmed the Service Worker fetch listener to respect browser F5/Ctrl+F5 requests (via <code>event.request.cache</code>). Tapping reload now completely bypasses the local PWA cache to fetch and re-validate resources directly from the network!</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Network-First Navigation: Upgraded primary document requests (like <code>index.html</code>) to use a Network-First strategy, ensuring the latest layout changes are instantly seen when online while maintaining robust offline fallbacks.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Instant PWA Updates: Implemented a service worker update detection and <code>controllerchange</code> auto-reload hook. As soon as a new dashboard version is deployed, the app will automatically synchronize and update in the background, reloading seamlessly to serve the fresh cache on the next visits with zero hard refreshes required!</span>
              </li>
            </ul>
          </div>

          <!-- v1.2.0 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.2.0</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Optional Email Follow-Up Field: Users can now optionally enter their email address in the feedback form if they want a direct contact or response from the developer (no promise of response).</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Enhanced Feedback Validation: Upgraded the feedback form to require a category selection, star rating, and message, with sleek error highlights.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Championship Leadership History: Dynamic tracking algorithms compute who led the standings after each individual Grand Prix round.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Interactive Progression Timeline: Added a horizontal scrolling leadership progression capsule bar on the dashboard's Points Tracker card, summarizing exactly which drivers led the title fight and across which rounds.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Modal Leadership Badges: Integrated dynamic "Championship Leader" milestone achievements detailing the exact rounds led when inspecting driver or constructor profiles, complete with range-based list compression (e.g. Rounds 1–3, 5–6) for clean readability!</span>
              </li>
            </ul>
          </div>

          <!-- v1.1.5 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.1.5</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>World Champion Clinch GP Analytics: Renders a gorgeous gold-glowing champion crown/trophy banner inside the Driver and Constructor profile modals if they have mathematically clinched the title, showing the exact Grand Prix circuit and round number of their championship security.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Standings Champion Clinch Indicator: Added mathematical algorithms to calculate maximum remaining points for active seasons. If the P1 driver or constructor has a points gap strictly greater than remaining points, they are dynamically highlighted with a gold background and a special "Clinched" badge before the season officially finishes!</span>
              </li>
            </ul>
          </div>

          <!-- v1.1.4 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.1.4</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Standings Champion Highlights: Dynamically detects completed seasons and awards the Driver World Champion and World Constructor Champion with glowing gold row backgrounds, left borders, and custom crown/trophy "Champion" badges!</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Driver Lineup End-of-Season Accuracy: Aggregates driver statistics chronologically to guarantee driver standings and acronyms display their correct end-of-season teams rather than start-of-season replacements.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Mid-Season Driver Swap Constructor Points: Computes and attributes constructor standings points and wins dynamically at the active race level, ensuring that points are allocated only to the constructors that the driver actively represented during their respective stints.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Improved</span>
                <span>Constructor Driver Contributions: Upgraded lineup contributions list to display the exact point splits scored by each driver specifically for that constructor.</span>
              </li>
            </ul>
          </div>

          <!-- v1.1.3 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.1.3</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Team Points Progression Chart: Renders a canvas line chart depicting constructor points week-by-week.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Reliability Analytics: Displays a calculated team reliability percentage and DNF statistics.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Interactive Teammate Duels: Compares teammates side-by-side on points contributions, best finishes, and GP/Sprint finishing head-to-heads.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Constructor Achievements: New gamified constructor milestone cards rewarding championship leaders, points dominance, and bulletproof reliability.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Sprint Statistics: Segmented toggle tabs in driver profile modal dynamically rendering comprehensive Sprint points, wins, podiums, and metrics.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Sprint Results Chart: Custom chronological bar chart detailing sprint finishing orders (P1–P20, DNF, DNS, DSQ).</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Sprint Achievements: New milestone badges including Sprint Master, Sprint Podium Finisher, Sprint Scorer, and Sprint Dominator.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Sprint Teammate H2H: Direct teammate head-to-head performance ratio for all sprint race sessions.</span>
              </li>
            </ul>
          </div>

          <!-- v1.1.2 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.1.2</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Resolved caching engine validation issues to guarantee 100% stable offline data persistence and instant season reloads upon manual page refresh (F5).</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Implemented interactive, glassmorphic Planned Features (Roadmap) Modal to display active and future development phases.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Added Roadmap buttons to navigation header and footer layouts, with full responsive alignments.</span>
              </li>
            </ul>
          </div>

          <!-- v1.1.1 -->
          <div class="changelog-card">
            <div class="changelog-header">
              <div class="changelog-version">v1.1.1</div>
              <div class="changelog-date">May 27, 2026</div>
            </div>
            <ul class="changelog-list">
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Added global queue-wide backoff cooldown for HTTP 429 rate limits, preventing parallel rate-limiting cascades.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Caching</span>
                <span>Implemented 30-minute transient placeholder caching for failed/incomplete GP compiles to prevent page refresh API hammers.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved">Telemetry</span>
                <span>Switched from raw crossing calculations to querying OpenF1's official <code>/session_result</code> API endpoint.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Programmatically resolved all post-race administrative time penalties and DSQs, preserving r.status in the compiler.</span>
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
                <span class="changelog-tag fixed">Fixed</span>
                <span>Guaranteed 100% chart-standings sync by compiling pointsHistory inside the core standings compiler, eliminating duplicate calculations.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag fixed">Fixed</span>
                <span>Resolved TypeError crash in Race Detail results rendering by safely parsing gap and pit telemetry as floats.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Season Year selector persistence in LocalStorage, remembering user's active year selection across page refreshes.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag added">Added</span>
                <span>Dynamic, glassmorphic hover tooltips on the Points Tracker chart, displaying real-time round scores for each driver.</span>
              </li>
              <li class="changelog-item">
                <span class="changelog-tag improved" style="background: rgba(155, 89, 182, 0.12); border-color: rgba(155, 89, 182, 0.25); color: #9b59b6;">PWA</span>
                <span>Upgraded Service Worker cache (v4) to a Stale-While-Revalidate strategy, delivering instant, zero-delay F5 page loads.</span>
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
 * Launch the Planned Features (Roadmap) interactive scrollable timeline modal
 */
export function showRoadmapModal() {
  ensureOverlay();
  const modal = document.getElementById('feedback-modal');
  modal.innerHTML = `
    <button class="driver-modal-close" id="fbm-close" aria-label="Close">✕</button>
    <div style="padding: var(--space-xl) var(--space-lg); font-family:'Outfit', sans-serif; position: relative; z-index: 5; max-height: 80vh; display: flex; flex-direction: column;">
      <h2 style="font-weight: 800; font-size: 1.5rem; color: var(--text-primary); margin-bottom: 4px; display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-lightbulb" style="color: var(--f1-red);"></i> Planned Features &amp; Ideas
      </h2>
      <p style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 16px;">
        A personal checklist of advanced analytics modules, telemetry tools, and visual ideas under consideration for future PitCorner releases.
      </p>

      <div style="flex: 1; overflow-y: auto; padding-right: 8px;" class="custom-scrollbar">
        <div class="changelog-timeline" style="padding-left: 0; margin-top: 8px;">
          
          <div class="changelog-timeline::before" style="display: none;"></div>
          
          <div class="changelog-card" style="border-left: 3px solid var(--f1-red);">
            <div class="changelog-header" style="margin-bottom: 14px;">
              <div class="changelog-version"><i class="fa-solid fa-list-check" style="color: var(--f1-red); margin-right: 6px;"></i> Things I'm Considering</div>
              <div class="changelog-date">Feature Backlog</div>
            </div>
            <ul class="changelog-list" style="gap: 16px;">
              <li class="changelog-item">
                <span class="roadmap-tag progress">Active Work</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">General Bug Squashing</strong>
                  <span>Continuous performance tuning, PWA asset loading speed-ups, and cleaning up console logs.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag progress">Active Work</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">Translation &amp; Localization Support</strong>
                  <span>Adding multi-language translation support to make PitCorner accessible to F1 fans around the world.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag planned">Planned</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">High-Resolution Driver Portraits</strong>
                  <span>Replacing default driver avatars with high-quality official portraits for all active drivers.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag planned">Planned</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">More Charts &amp; Visual Analytics</strong>
                  <span>Introducing additional grid graphs, lap time progression indicators, and qualifying teammate battle overlays.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag planned">Planned</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">Expanded Track Details &amp; Trivia</strong>
                  <span>Detailed telemetry dashboards for circuits showing historical stats, overtakes index, and lap records.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag backlog">Backlog Idea</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">Historical F1 Data (Back to 1950s)</strong>
                  <span>Integrating historical seasonal data calendars and standings records dating back to F1's inaugural 1950 season.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag backlog">Backlog Idea</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">Comprehensive Driver Profiles</strong>
                  <span>Deeper driver history screens outlining full career stats, team history, accomplishments, and milestones.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag backlog">Backlog Idea</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">All-Time Driver Head-to-Head (H2H)</strong>
                  <span>Expanding H2H comparison features to support evaluating any two drivers across any era in F1 history.</span>
                </div>
              </li>
              <li class="changelog-item">
                <span class="roadmap-tag backlog">Backlog Idea</span>
                <div>
                  <strong style="color: var(--text-primary); display: block; font-size: 0.85rem; margin-bottom: 2px;">High-Fidelity Interactive Track Maps</strong>
                  <span>Upgrading basic track layouts with rich vector graphics, detailed corner profiles, DRS, SM zones, and speed traps.</span>
                </div>
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
  const navRmBtn = document.getElementById('nav-roadmap-btn');
  const footerRmBtn = document.getElementById('footer-roadmap-btn');
  const footerFbBtn = document.getElementById('footer-feedback-btn');
  const footerSpBtn = document.getElementById('footer-support-btn');

  const triggerChangelog = () => showChangelogModal();
  const triggerRoadmap = () => showRoadmapModal();

  if (navClBtn) {
    navClBtn.addEventListener('click', triggerChangelog);
  }

  if (footerClBtn) {
    footerClBtn.addEventListener('click', triggerChangelog);
  }

  if (navRmBtn) {
    navRmBtn.addEventListener('click', triggerRoadmap);
  }

  if (footerRmBtn) {
    footerRmBtn.addEventListener('click', triggerRoadmap);
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

/**
 * Launch the Clear Cache choice and confirmation modal
 */
export function showClearCacheModal(year, onClearSeason, onClearAll) {
  ensureOverlay();
  const modal = document.getElementById('feedback-modal');
  modal.style.maxWidth = '500px';
  modal.innerHTML = `
    <button class="driver-modal-close" id="fbm-close" aria-label="Close">✕</button>
    <div style="padding: var(--space-xl) var(--space-lg); font-family:'Outfit', sans-serif; position: relative; z-index: 5;">
      <h2 style="font-weight: 800; font-size: 1.5rem; color: var(--text-primary); margin-bottom: 8px; display:flex; align-items:center; gap:10px;">
        <i class="fa-solid fa-trash-can" style="color: var(--f1-red);"></i> Clear Data Cache
      </h2>
      <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 24px; line-height: 1.5;">
        Select an option below to clear your local database cache. Clearing helps resolve data glitches or force live updates.
      </p>

      <div style="display:flex; flex-direction:column; gap:16px;">
        <!-- Option 1: Current Season Only -->
        <div class="cache-option-card" id="clear-season-opt" style="border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-md); cursor:pointer; transition: all var(--transition-fast); background: rgba(255,255,255,0.01); box-sizing: border-box;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 6px; flex-wrap: wrap; gap: 8px;">
            <strong style="color: var(--text-primary); font-size: 0.95rem; display:flex; align-items:center; gap:8px;">
              <i class="fa-solid fa-calendar-day" style="color: var(--f1-red);"></i> Clear viewed ${year} season only
            </strong>
            <span class="changelog-tag improved" style="margin: 0; padding: 2px 6px; font-size: 0.65rem;">Recommended</span>
          </div>
          <p style="font-size: 0.78rem; color: var(--text-muted); line-height: 1.4; margin: 0;">
            Wipes cached telemetry, race results, and standings only for the selected viewed year. Other seasons will remain cached.
          </p>
        </div>

        <!-- Option 2: Full Wiping -->
        <div class="cache-option-card" id="clear-all-opt" style="border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-md); cursor:pointer; transition: all var(--transition-fast); background: rgba(255,255,255,0.01); box-sizing: border-box;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 6px;">
            <strong style="color: var(--text-primary); font-size: 0.95rem; display:flex; align-items:center; gap:8px;">
              <i class="fa-solid fa-database" style="color: var(--f1-red);"></i> Clear entire cache (All years)
            </strong>
          </div>
          <p style="font-size: 0.78rem; color: var(--text-muted); line-height: 1.4; margin: 0;">
            Performs a full wipe of all F1 seasons, driver profiles, lap telemetry, and system caches. Highly thorough reset.
          </p>
        </div>
      </div>

      <div style="display:flex; align-items:center; justify-content:flex-end; gap:12px; margin-top: var(--space-xl);">
        <button id="cache-cancel-btn" class="nav-action-btn" style="padding: 10px 18px; font-size: 0.85rem; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); background:transparent; color: var(--text-secondary); cursor:pointer; font-weight: 600;">
          Cancel
        </button>
      </div>
    </div>
  `;

  const closeBtn = document.getElementById('fbm-close');
  const cancelBtn = document.getElementById('cache-cancel-btn');
  const seasonOpt = document.getElementById('clear-season-opt');
  const allOpt = document.getElementById('clear-all-opt');

  const close = () => {
    closeModal();
  };

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  // Add hover effects dynamically
  [seasonOpt, allOpt].forEach(opt => {
    opt.addEventListener('mouseenter', () => {
      opt.style.borderColor = 'var(--f1-red)';
      opt.style.background = 'rgba(225, 6, 0, 0.03)';
      opt.style.transform = 'translateY(-1px)';
      opt.style.boxShadow = '0 4px 15px rgba(225, 6, 0, 0.08)';
    });
    opt.addEventListener('mouseleave', () => {
      opt.style.borderColor = 'var(--border-subtle)';
      opt.style.background = 'rgba(255,255,255,0.01)';
      opt.style.transform = 'translateY(0)';
      opt.style.boxShadow = 'none';
    });
  });

  seasonOpt.addEventListener('click', () => {
    close();
    onClearSeason();
  });

  allOpt.addEventListener('click', () => {
    close();
    onClearAll();
  });

  document.body.style.overflow = 'hidden';
  overlay.classList.add('open');
}
