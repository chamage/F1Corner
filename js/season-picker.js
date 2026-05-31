// =============================================
// PITCORNER — Visual Cockpit Season Picker Modal
// =============================================

export function openSeasonPickerModal(currentYear, availableYears, onYearSelect) {
  let overlay = document.getElementById('season-picker-overlay');
  
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'season-modal-overlay';
    overlay.id = 'season-picker-overlay';
    overlay.innerHTML = `
      <div class="season-modal">
        <button class="season-modal-close" id="season-picker-close" aria-label="Close">✕</button>
        <div class="season-modal-header">
          <h2>SELECT CHAMPIONSHIP SEASON</h2>
          <p>Explore Formula 1 seasons from 1950 to 2026</p>
        </div>
        <div class="season-modal-body">
          <div class="season-decades-column" id="season-decades-list"></div>
          <div class="season-years-grid" id="season-years-grid"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Event listener to close modal
    const closeBtn = overlay.querySelector('#season-picker-close');
    closeBtn.addEventListener('click', () => closeModal());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    // Escape key listener
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
    });
  }

  const decadesList = overlay.querySelector('#season-decades-list');
  const yearsGrid = overlay.querySelector('#season-years-grid');

  // Compute active decade for the current year
  const initialDecade = Math.floor(currentYear / 10) * 10;

  // Group years by decades
  const yearsByDecade = {};
  for (const year of availableYears) {
    const decade = Math.floor(year / 10) * 10;
    if (!yearsByDecade[decade]) {
      yearsByDecade[decade] = [];
    }
    yearsByDecade[decade].push(year);
  }

  // Sort decades descending
  const decades = Object.keys(yearsByDecade).map(Number).sort((a, b) => b - a);

  function renderDecades(activeDecade) {
    decadesList.innerHTML = '';
    decades.forEach(decade => {
      const btn = document.createElement('button');
      btn.className = `decade-btn${decade === activeDecade ? ' active' : ''}`;
      
      // On mobile screens, hide the right icon to keep it clean
      btn.innerHTML = `
        <span>${decade}s</span>
        <i class="fa-solid fa-chevron-right" style="font-size:0.6rem;opacity:0.6;"></i>
      `;
      
      btn.addEventListener('click', () => {
        renderDecades(decade);
        renderYears(decade);
      });
      decadesList.appendChild(btn);
    });
  }

  function renderYears(decade) {
    yearsGrid.innerHTML = '';
    const years = yearsByDecade[decade] || [];
    // Sort years descending within the decade
    years.sort((a, b) => b - a).forEach(year => {
      const btn = document.createElement('button');
      btn.className = `year-grid-btn${year === currentYear ? ' active' : ''}`;
      btn.textContent = year;
      btn.addEventListener('click', () => {
        onYearSelect(year);
        closeModal();
      });
      yearsGrid.appendChild(btn);
    });
  }

  function closeModal() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  // Initial render
  renderDecades(initialDecade);
  renderYears(initialDecade);

  // Open modal
  setTimeout(() => {
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }, 10);
}
