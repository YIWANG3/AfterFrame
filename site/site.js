// Progressive enhancement: all content and navigation work without JavaScript.
if ('IntersectionObserver' in window) {
  const sections = document.querySelectorAll('.feature');
  const reveal = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        reveal.unobserve(entry.target);
      }
    }
  }, { threshold: 0.08 });
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sections.forEach(section => {
      section.classList.add('reveal-pending');
      reveal.observe(section);
    });
  }
  const links = [...document.querySelectorAll('aside a[href^="#"]')];
  const current = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach(link => {
        if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }
  }, { rootMargin: '-15% 0px -60% 0px' });
  links.forEach(link => {
    const target = document.getElementById(link.hash.slice(1));
    if (target) current.observe(target);
  });
}
