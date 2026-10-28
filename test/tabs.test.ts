import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readTabs } from "../src/sim.ts";

/** The part of SafariTabs.db that readTabs reads, as iOS 26.3's Safari lays it out. */
function fixture(rows: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "tabs-")), "SafariTabs.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, parent INTEGER, type INTEGER, title TEXT, url TEXT,
      hidden INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, order_index INTEGER NOT NULL, date_closed REAL);
    CREATE TABLE windows (id INTEGER PRIMARY KEY, active_tab_group_id INTEGER, local_tab_group_id INTEGER,
      private_tab_group_id INTEGER, date_closed REAL);
    CREATE TABLE windows_tab_groups (id INTEGER PRIMARY KEY, active_tab_id INTEGER, tab_group_id INTEGER,
      window_id INTEGER);
    ${rows}`);
  db.close();
  return file;
}

test("no db, or one Safari is still creating, is no tabs", () => {
  assert.deepEqual(readTabs("/nonexistent/SafariTabs.db"), []);
  const file = join(mkdtempSync(join(tmpdir(), "tabs-")), "SafariTabs.db");
  new DatabaseSync(file).close();
  assert.deepEqual(readTabs(file), []);
});

test("the shown group's tabs in order, with the active one; hidden, deleted and closed tabs left out", () => {
  const file = fixture(`
    INSERT INTO bookmarks (id, parent, type, title, url, order_index) VALUES
      (6, NULL, 1, 'Local', '', 0), (7, NULL, 1, 'Private', '', 0),
      (8, 6, 0, 'B', 'http://b/', 1), (9, 7, 0, 'Start Page', '', 0), (10, 6, 0, 'A', 'http://a/', 0),
      (11, 6, 0, 'C', 'http://c/', 2), (20, 30, 0, 'Other window', 'http://w2/', 0);
    INSERT INTO bookmarks (id, parent, type, title, url, order_index, hidden) VALUES (12, 6, 0, 'H', 'http://h/', 3, 1);
    INSERT INTO bookmarks (id, parent, type, title, url, order_index, deleted) VALUES (13, 6, 0, 'D', 'http://d/', 4, 1);
    INSERT INTO bookmarks (id, parent, type, title, url, order_index, date_closed) VALUES (14, 6, 0, 'X', 'http://x/', 5, 1.5);
    INSERT INTO windows VALUES (1, 6, 6, 7, NULL), (2, 30, 30, 31, NULL);
    INSERT INTO windows_tab_groups VALUES (1, 8, 6, 1);`);
  const tabs = readTabs(file);
  assert.deepEqual(
    tabs.map((t) => [t.window, t.url, t.active, t.private]),
    [
      [1, "http://a/", false, false],
      [1, "http://b/", true, false],
      [1, "http://c/", false, false],
      [2, "http://w2/", true, false], // one tab and no active row: a fresh window
    ],
  );
});

test("a window showing its private group lists those tabs", () => {
  const file = fixture(`
    INSERT INTO bookmarks (id, parent, type, title, url, order_index) VALUES
      (8, 6, 0, 'Public', 'http://p/', 0), (9, 7, 0, 'Secret', 'http://s/', 0), (10, 7, 0, 'Secret 2', 'http://t/', 1);
    INSERT INTO windows VALUES (1, 7, 6, 7, NULL);
    INSERT INTO windows_tab_groups VALUES (1, 8, 6, 1), (2, 10, 7, 1);`);
  assert.deepEqual(
    readTabs(file).map((t) => [t.title, t.active, t.private]),
    [
      ["Secret", false, true],
      ["Secret 2", true, true],
    ],
  );
});
