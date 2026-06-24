import './style.css';
import { initGallery } from './gallery';
import { initLightbox } from './lightbox';
import { initSelection } from './select';
import { initUpload } from './upload';
import { initBottomSignature } from './bottom-signature';
import { icon } from './icons';

const gallery = initGallery();
const lightbox = initLightbox(gallery.getItems);
const HOME_URL = 'https://pics.example.com/';
const CENTRE_URL = 'https://centre.example.com/';

initToolbarSearch(gallery.setSearch);
initSelection(gallery.getItems, gallery.getTotal, gallery.getSearch, lightbox.open, gallery.removeItems);
initUpload(gallery.prependPending);
initBottomSignature({ isComplete: gallery.isComplete });
void gallery.loadInitial();

function openCentre(): void {
  const opened = window.open(CENTRE_URL, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}

function normalizeHomeUrl(): void {
  const home = new URL(HOME_URL);
  if (window.location.origin !== home.origin) return;
  if (window.location.pathname === '/' && !window.location.search && !window.location.hash) return;
  window.history.replaceState(null, '', '/');
}

function initBrandHome(): void {
  const brand = document.querySelector<HTMLElement>('.brand');
  if (!brand) return;
  revealBrandWhenReady(brand);
  brand.setAttribute('role', 'link');
  brand.tabIndex = 0;
  brand.title = 'NormalWorkspace';
  brand.addEventListener('click', openCentre);
  brand.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openCentre();
  });
}

function revealBrandWhenReady(brand: HTMLElement): void {
  if (!('fonts' in document)) {
    brand.classList.add('brand-ready');
    return;
  }
  void document.fonts.load('400 14px "Bungee"').then(() => {
    if (document.fonts.check('400 14px "Bungee"')) {
      brand.classList.add('brand-ready');
    }
  }).catch(() => {
    // Keep the brand hidden instead of flashing a fallback face.
  });
}

function initToolbarSearch(onSearch: (query: string) => void): void {
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return;

  const search = document.createElement('form');
  search.className = 'toolbar-search';
  search.setAttribute('role', 'search');
  search.innerHTML = `${icon('search', 15)}<input type="search" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Search"><button type="button" class="search-clear" aria-label="Clear search">${icon('x', 13)}</button>`;

  const actions = document.createElement('div');
  actions.id = 'toolbar-actions';
  toolbar.append(search, actions);

  const input = search.querySelector<HTMLInputElement>('input')!;
  const clear = search.querySelector<HTMLButtonElement>('.search-clear')!;
  let timer = 0;
  const syncClear = () => search.classList.toggle('has-value', input.value.length > 0);
  const applySearch = () => {
    syncClear();
    onSearch(input.value);
  };
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    syncClear();
    timer = window.setTimeout(applySearch, 180);
  });
  clear.addEventListener('click', () => {
    if (!input.value) return;
    window.clearTimeout(timer);
    input.value = '';
    applySearch();
    normalizeHomeUrl();
    input.focus();
  });
  search.addEventListener('submit', (event) => {
    event.preventDefault();
    applySearch();
  });
}

initBrandHome();
