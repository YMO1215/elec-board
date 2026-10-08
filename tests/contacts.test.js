import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CONTACTS, addContact, initialState, parse, removeContact, updateContact } from "../js/store.js";

const one = { id: "c1", company: "한전KPS", name: "홍길동", phone: "010-1234-5678" };

test("a new board starts with no contacts; old boards without the field parse to an empty list", () => {
  assert.deepEqual(initialState().contacts, []);
  const old = JSON.stringify({ version: 1, people: initialState().people, tasks: [] });
  assert.deepEqual(parse(old).contacts, []);
});

test("addContact trims fields, appends, and ignores empty rows and repeated ids", () => {
  let s = addContact(initialState(), { id: "c1", company: "  한전KPS ", name: "홍길동", phone: " 010-1234-5678 " });
  assert.deepEqual(s.contacts, [one]);
  assert.equal(addContact(s, one), s); // same id (a retried op) changes nothing
  assert.equal(addContact(s, { id: "c2", company: " ", name: "", phone: "" }), s);
  s = addContact(s, { id: "c2", company: "", name: "김철수", phone: "" }); // one field is enough
  assert.equal(s.contacts.length, 2);
});

test("updateContact edits only the given fields and refuses to blank a row", () => {
  const s = addContact(initialState(), one);
  assert.equal(updateContact(s, "c1", { phone: "02-111-2222" }).contacts[0].phone, "02-111-2222");
  assert.equal(updateContact(s, "c1", { phone: "02-111-2222" }).contacts[0].company, "한전KPS");
  assert.equal(updateContact(s, "c1", { company: "", name: "", phone: "" }), s);
  assert.equal(updateContact(s, "zzz", { name: "x" }), s);
});

test("removeContact deletes by id", () => {
  const s = addContact(initialState(), one);
  assert.deepEqual(removeContact(s, "c1").contacts, []);
  assert.equal(removeContact(s, "zzz"), s);
});

test("parse survives a round trip and drops malformed / duplicate contacts", () => {
  const s = addContact(initialState(), one);
  assert.deepEqual(parse(JSON.stringify(s)).contacts, [one]);
  const dirty = { ...s, contacts: [one, one, { id: "x" }, null, { company: "id 없음" }, { id: "c9", company: 5, name: "숫자", phone: null }] };
  const out = parse(JSON.stringify(dirty)).contacts;
  assert.deepEqual(out.map((c) => c.id), ["c1", "c9"]);
  assert.equal(out[1].company, "5");
});

test("the list is capped at MAX_CONTACTS", () => {
  let s = initialState();
  for (let i = 0; i < MAX_CONTACTS + 5; i += 1) s = addContact(s, { id: `c${i}`, company: `업체${i}` });
  assert.equal(s.contacts.length, MAX_CONTACTS);
});
