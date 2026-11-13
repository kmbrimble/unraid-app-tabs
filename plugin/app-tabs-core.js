/**
 * App Tabs core: the label/URL rules, [HOST] resolution and mixed-content test, in one place.
 * UMD, so the settings app and the generated tab pages (browser, window.appTabs) and `node tests/js.test.js` share one
 * implementation. The PHP twin is plugin/include/config.php; tests/vectors.json is run through both.
 * Pure functions only: nothing here touches the DOM, storage or the network.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.appTabs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_TABS = 12;
  var LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._+-]{0,22}[A-Za-z0-9])?$|^[A-Za-z0-9]$/;
  // scheme, then the host: the [HOST] placeholder (the whole host, nothing around it), a bracketed IPv6 literal, or a
  // plain name/IPv4; optional port; optional path/query/fragment. No userinfo: an '@' before the first '/' cannot match.
  var URL_RE = /^(https?):\/\/(\[HOST\]|\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?((?:[/?#]).*)?$/;
  // Anything that could break out of an attribute, a header or a shell-ish context, or that has no business in a URL.
  var URL_FORBIDDEN = /[^\x21-\x7e]|["'`<>\\^{}|]/;

  function validateLabel(label) {
    if (typeof label !== 'string' || label === '') return 'Enter a label.';
    if (label.length > 24) return 'Use 24 characters or fewer.';
    if (!LABEL_RE.test(label)) {
      return 'Use letters, digits, spaces and . _ + - only, starting and ending with a letter or digit.';
    }
    return null;
  }

  /** File-name stem for a label: runs of anything but letters/digits become one '-'. Case is kept. */
  function slugOf(label) {
    return String(label).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function validateUrl(url) {
    if (typeof url !== 'string' || url === '') return 'Enter a URL.';
    if (url.length > 2048) return 'That URL is too long.';
    if (URL_FORBIDDEN.test(url)) return 'The URL has a space or a character that is not allowed in a URL (encode it, for example %20).';
    var m = URL_RE.exec(url);
    if (!m) return 'Use an http:// or https:// address, for example http://[HOST]:9898/ (no user name or password).';
    if (m[3] !== undefined) {
      var port = parseInt(m[3], 10);
      if (port < 1 || port > 65535) return 'The port must be between 1 and 65535.';
    }
    if (m[2].charAt(0) === '[' && m[2] !== '[HOST]' && (m[2].indexOf(':') === -1 || m[2].indexOf(':::') !== -1 || m[2].length > 47)) return 'That is not a valid IPv6 address.';
    // The only square brackets allowed anywhere are the host's own.
    var rest = m[4] || '';
    if (rest.indexOf('[') !== -1 || rest.indexOf(']') !== -1) return 'Square brackets are only allowed as [HOST] or an IPv6 address in the host part.';
    return null;
  }

  /** Replace the placeholder with the host the GUI is being viewed on (location.hostname: IPv6 already bracketed). */
  function resolveUrl(url, hostname) {
    return String(url).replace('[HOST]', hostname);
  }

  /** An https GUI cannot embed an http app: the browser blocks it (mixed content). */
  function isMixedContent(guiProtocol, resolvedUrl) {
    return guiProtocol === 'https:' && /^http:/.test(resolvedUrl);
  }

  /** Validates a whole list; returns an array of {index, field, message}. Empty array = valid. */
  function validateTabs(tabs) {
    var errors = [];
    if (!Array.isArray(tabs)) return [{ index: -1, field: 'tabs', message: 'Tabs must be a list.' }];
    if (tabs.length > MAX_TABS) errors.push({ index: -1, field: 'tabs', message: 'At most ' + MAX_TABS + ' tabs.' });
    var seen = Object.create(null);
    tabs.forEach(function (t, i) {
      var e = validateLabel(t && t.label);
      if (e) errors.push({ index: i, field: 'label', message: e });
      else {
        var k = slugOf(t.label).toLowerCase();
        if (k in seen) errors.push({ index: i, field: 'label', message: 'Another tab already uses that label.' });
        seen[k] = i;
      }
      e = validateUrl(t && t.url);
      if (e) errors.push({ index: i, field: 'url', message: e });
      if (!t || (t.open !== 'iframe' && t.open !== 'newtab')) errors.push({ index: i, field: 'open', message: 'Choose how to open the app.' });
      if (!t || typeof t.enabled !== 'boolean') errors.push({ index: i, field: 'enabled', message: 'Enabled must be true or false.' });
    });
    return errors;
  }

  return { MAX_TABS: MAX_TABS, validateLabel: validateLabel, slugOf: slugOf, validateUrl: validateUrl, resolveUrl: resolveUrl, isMixedContent: isMixedContent, validateTabs: validateTabs };
});
