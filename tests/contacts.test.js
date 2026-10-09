import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CONTACTS, addCategory, addContact, formatPhone, initialState, parse, removeCategory, removeContact, renameCategory, updateContact } from "../js/store.js";

const one = { id: "c1", company: "한전KPS", name: "홍길동", phone: "010-1234-5678", car: "", memo: "", cat: "" };

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

test("차량번호 and 직무 메모 are stored, trimmed, capped, and old rows get empty values", () => {
  let s = addContact(initialState(), { id: "c1", company: "A", car: " 12가 3456 ", memo: "  야간 담당\n비상시 먼저 연락  " });
  assert.equal(s.contacts[0].car, "12가 3456");
  assert.equal(s.contacts[0].memo, "야간 담당\n비상시 먼저 연락");
  assert.equal(addContact(initialState(), { id: "c2", car: "34나 7890" }).contacts.length, 1); // a car number alone is enough
  assert.equal(addContact(s, { id: "c3", memo: "x".repeat(500) }).contacts[1].memo.length, 200);
  s = updateContact(s, "c1", { car: "56다 1111" });
  assert.equal(s.contacts[0].car, "56다 1111");
  assert.equal(s.contacts[0].memo, "야간 담당\n비상시 먼저 연락");
  const legacy = { ...initialState(), contacts: [{ id: "old", company: "옛 업체", name: "", phone: "" }] };
  assert.deepEqual(parse(JSON.stringify(legacy)).contacts[0], { id: "old", company: "옛 업체", name: "", phone: "", car: "", memo: "", cat: "" });
});

test("formatPhone keeps digits only and places hyphens while typing", () => {
  const cases = [
    ["", ""], ["0", "0"], ["010", "010"], ["0101", "010-1"], ["01012345678", "010-1234-5678"], ["0101234", "010-1234"],
    ["010-1234-5678", "010-1234-5678"], ["010 1234 5678 9", "010-1234-5678"], ["abc010x1234", "010-1234"],
    ["021234567", "02-123-4567"], ["0212345678", "02-1234-5678"], ["0311234567", "031-123-4567"], ["03112345678", "031-1234-5678"],
  ];
  for (const [input, want] of cases) assert.equal(formatPhone(input), want, JSON.stringify(input));
});

test("categories: add / rename / remove, with unique names and a cap", () => {
  let s = addCategory(initialState(), { id: "k1", name: " 협력업체 " });
  assert.deepEqual(s.categories, [{ id: "k1", name: "협력업체" }]);
  assert.equal(addCategory(s, { id: "k2", name: "협력업체" }), s); // same name
  assert.equal(addCategory(s, { id: "k1", name: "다른" }), s); // same id
  assert.equal(addCategory(s, { id: "k3", name: "  " }), s);
  s = addCategory(s, { id: "k2", name: "관공서" });
  assert.equal(renameCategory(s, "k2", "관청").categories[1].name, "관청");
  assert.equal(renameCategory(s, "k2", "협력업체"), s); // name taken
  assert.equal(renameCategory(s, "zzz", "x"), s);
  let t = initialState();
  for (let i = 0; i < 25; i += 1) t = addCategory(t, { id: `k${i}`, name: `분류${i}` });
  assert.equal(t.categories.length, 20);
});

test("a contact keeps its category; unknown categories fall back to 미분류; removing a category keeps the contacts", () => {
  let s = addCategory(initialState(), { id: "k1", name: "협력업체" });
  s = addContact(s, { id: "c1", company: "A", cat: "k1" });
  s = addContact(s, { id: "c2", company: "B", cat: "nope" });
  assert.deepEqual(s.contacts.map((c) => c.cat), ["k1", ""]);
  s = updateContact(s, "c2", { cat: "k1" });
  assert.equal(s.contacts[1].cat, "k1");
  assert.deepEqual(parse(JSON.stringify(s)).contacts.map((c) => c.cat), ["k1", "k1"]);
  const gone = removeCategory(s, "k1");
  assert.deepEqual(gone.categories, []);
  assert.deepEqual(gone.contacts.map((c) => [c.company, c.cat]), [["A", ""], ["B", ""]]);
  assert.equal(removeCategory(s, "zzz"), s);
  // a board saved before categories existed
  assert.deepEqual(parse(JSON.stringify({ ...initialState(), categories: undefined })).categories, []);
});
