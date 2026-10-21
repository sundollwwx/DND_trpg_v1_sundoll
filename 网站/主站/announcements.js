"use strict";

(() => {
  const list = document.getElementById("announcement-list");
  const pagination = document.getElementById("announcement-pagination");
  const previous = document.getElementById("announcement-prev");
  const next = document.getElementById("announcement-next");
  const state = document.getElementById("announcement-page-state");
  if (!list || !pagination || !previous || !next || !state) return;

  const requestedPageSize = Number(list.dataset.pageSize);
  const pageSize = Number.isInteger(requestedPageSize) && requestedPageSize >= 1 && requestedPageSize <= 20 ? requestedPageSize : 7;
  let page = 0;

  function normalize(data) {
    if (!Array.isArray(data)) return [];
    return data
      .map((item, order) => ({ item, order }))
      .filter(({ item }) => {
        if (!item || typeof item.title !== "string" || !item.title.trim()) return false;
        if (typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return false;
        const date = new Date(`${item.date}T00:00:00Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === item.date;
      })
      .sort((a, b) => b.item.date.localeCompare(a.item.date) || a.order - b.order)
      .map(({ item }) => ({
        date: item.date,
        title: item.title.trim(),
        id: typeof item.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) ? item.id : "",
        hasBody: item.hasBody === true || (Array.isArray(item.body) && item.body.some((paragraph) => typeof paragraph === "string" && paragraph.trim())),
      }));
  }

  const fallback = Array.from(list.querySelectorAll("article.announcement"), (article) => ({
    date: article.querySelector("time")?.getAttribute("datetime"),
    title: article.querySelector("h3")?.textContent,
    id: article.dataset.noticeId,
    hasBody: Boolean(article.querySelector("a.announcement-title-link")),
  }));
  let announcements = normalize(fallback);

  function updateControls() {
    const pages = Math.max(1, Math.ceil(announcements.length / pageSize));
    pagination.hidden = announcements.length <= pageSize;
    previous.disabled = page === 0;
    next.disabled = page >= pages - 1;
    state.textContent = `${page + 1} / ${pages}`;
  }

  function render() {
    const fragment = document.createDocumentFragment();
    for (const item of announcements.slice(page * pageSize, (page + 1) * pageSize)) {
      const article = document.createElement("article");
      article.className = "announcement";
      const date = document.createElement("time");
      date.setAttribute("datetime", item.date);
      date.textContent = item.date.replaceAll("-", ".");
      const title = document.createElement("h3");
      if (item.id && item.hasBody) {
        const link = document.createElement("a");
        link.className = "announcement-title-link";
        link.href = `/news/${item.id}.html`;
        link.textContent = item.title;
        title.append(link);
      } else {
        title.textContent = item.title;
      }
      const star = document.createElement("span");
      star.className = "announcement-star";
      star.setAttribute("aria-hidden", "true");
      star.textContent = "✦";
      article.append(date, title, star);
      fragment.append(article);
    }
    list.replaceChildren(fragment);
    updateControls();
  }

  previous.addEventListener("click", () => {
    if (page <= 0) return;
    page -= 1;
    render();
  });
  next.addEventListener("click", () => {
    if ((page + 1) * pageSize >= announcements.length) return;
    page += 1;
    render();
  });
  render();

  fetch("/announcements.json", { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error("Announcements unavailable");
      return response.json();
    })
    .then((data) => {
      const valid = normalize(data);
      if (!valid.length) return;
      announcements = valid;
      page = 0;
      render();
    })
    .catch(() => {});
})();
