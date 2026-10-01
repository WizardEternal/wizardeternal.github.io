/*
  Light / dark switch, loaded on every page. The choice is stored in
  localStorage ("theme") and set as data-theme on <html>. With no stored choice
  the CSS follows prefers-color-scheme. The inline <head> script applies a
  stored choice before first paint; this file wires up the button and keeps its
  label and the theme-color meta in step.
*/
(function () {
  'use strict';
  var KEY = 'theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readStored() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) { return null; }
  }
  function writeStored(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* private mode: the choice lasts for this page only */ }
  }
  function current() {
    var a = root.getAttribute('data-theme');
    if (a === 'light' || a === 'dark') return a;
    return mq && mq.matches ? 'dark' : 'light';
  }
  function sync() {
    var next = current() === 'dark' ? 'light' : 'dark';
    var label = 'Switch to ' + next + ' mode';
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-label', label);
      buttons[i].setAttribute('title', label);
    }
    var paper = '';
    try { paper = getComputedStyle(root).getPropertyValue('--paper').trim(); } catch (e) { /* ignore */ }
    if (paper) {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var j = 0; j < metas.length; j++) metas[j].setAttribute('content', paper);
    }
  }
  function apply(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    sync();
  }

  // The <head> script normally did this already; repeat it in case it was stripped.
  root.classList.add('theme-js');
  var saved = readStored();
  if (saved && root.getAttribute('data-theme') !== saved) root.setAttribute('data-theme', saved);

  function wire() {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        writeStored(next);
        apply(next);
      });
    }
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  // No stored choice: follow the operating system live (the CSS already does; this keeps the label right).
  if (mq) {
    var onOs = function () { if (!readStored()) apply(null); };
    if (mq.addEventListener) mq.addEventListener('change', onOs);
    else if (mq.addListener) mq.addListener(onOs);
  }
  // A choice made in another tab.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) apply(readStored());
  });
})();
