// services/bookmarks.service.js
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const MAX_BOOKMARKS = 8;

function loadBookmarks() {
  const bookmarksPath = path.join(__dirname, "..", "bookmarks.env");

  if (!fs.existsSync(bookmarksPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(bookmarksPath);
    const parsed = dotenv.parse(raw);

    const bookmarks = [];

    for (let i = 1; i <= MAX_BOOKMARKS; i++) {
      const title = parsed[`BOOKMARK${i}_TITLE`];
      const url = parsed[`BOOKMARK${i}_URL`];

      if (title && url) {
        bookmarks.push({
          title: title.trim(),
          url: url.trim(),
        });
      }
    }

    return bookmarks;
  } catch (err) {
    console.error("Failed to load bookmarks.env:", err);
    return [];
  }
}

module.exports = {
  loadBookmarks,
};
