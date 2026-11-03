// Page-view counting, only where UMAMI_SRC and UMAMI_WEBSITE_ID are set (docker-entrypoint.sh).
// The query and the hash stay out of it: a viewer URL's ?load= can hold a share link or a SAS signature.
(function () {
  if (!window.__UMAMI_SRC__ || !window.__UMAMI_WEBSITE_ID__) return;
  var s = document.createElement('script');
  s.defer = true;
  s.src = window.__UMAMI_SRC__;
  s.setAttribute('data-website-id', window.__UMAMI_WEBSITE_ID__);
  s.setAttribute('data-exclude-search', 'true');
  s.setAttribute('data-exclude-hash', 'true');
  document.head.appendChild(s);
})();
