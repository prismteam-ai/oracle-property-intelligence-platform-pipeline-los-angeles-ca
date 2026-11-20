import { expect, test } from "vitest";
import {
  normalizeStreet,
  parsePermitAddress,
  parseRollHouse,
} from "../src/address-normalize.ts";

test.each([
  ["MAIN ST", "MAIN ST"],
  ["Main Street", "MAIN ST"],
  ["main st.", "MAIN ST"],
  ["LA BREA AVENUE", "LA BREA AVE"],
  ["SUNSET BLVD  ", "SUNSET BLVD"],
  ["OCEAN BOULEVARD E", "OCEAN BLVD"],
  ["MAIN ST 1-4", "MAIN ST"],
  ["MAIN ST #5", "MAIN ST"],
  ["MAIN ST#5", "MAIN ST"],
  ["MAIN ST UNIT 2", "MAIN ST"],
  ["MAIN ST APT B", "MAIN ST"],
  ["MAIN ST SUITE 100", "MAIN ST"],
  ["MAIN ST, BLDG 3", "MAIN ST"],
  ["MAIN ST GARAGE", "MAIN ST"],
  ["AVENUE 50", "AVE 50"],
  ["AVENUE OF THE STARS", "AVE OF THE STARS"],
  ["ST ANDREWS PL", "ST ANDREWS PL"],
  ["3RD ST", "3RD ST"],
  ["BROADWAY", "BROADWAY"],
  ["BROADWAY #2", "BROADWAY"],
  ["CIRCLE DR", "CIR DR"],
  ["#5", null],
  ["", null],
  [null, null],
])("street %j → %j", (input, key) => {
  expect(normalizeStreet(input)).toBe(key);
});

test.each([
  [
    "1234 W MAIN ST",
    { house: 1234, fraction: null, direction: "W", street: "MAIN ST" },
  ],
  [
    "1234-1240 W MAIN ST",
    { house: 1234, fraction: null, direction: "W", street: "MAIN ST" },
  ],
  [
    "1234 1/2 S MAIN STREET #3",
    { house: 1234, fraction: "1/2", direction: "S", street: "MAIN ST" },
  ],
  [
    "1234 MAIN ST 1-4",
    { house: 1234, fraction: null, direction: null, street: "MAIN ST" },
  ],
  [
    "10 N BROADWAY",
    { house: 10, fraction: null, direction: "N", street: "BROADWAY" },
  ],
  // A lone direction letter after the number is the street, not a direction.
  ["10 E", { house: 10, fraction: null, direction: null, street: "E" }],
  [
    "  77 e. 3rd st.  ",
    { house: 77, fraction: null, direction: "E", street: "3RD ST" },
  ],
])("permit %j", (input, parsed) => {
  expect(parsePermitAddress(input)).toEqual(parsed);
});

test.each([
  ["MAIN ST"],
  ["W MAIN ST"],
  ["12A MAIN ST"],
  ["1234"],
  [""],
  [null],
])("permit %j has no usable address", (input) => {
  expect(parsePermitAddress(input)).toBeNull();
});

test.each([
  ["1234", { house: 1234, fraction: null }],
  ["1234 1/2", { house: 1234, fraction: "1/2" }],
  [" 12 a ", { house: 12, fraction: "A" }],
  ["A12", null],
  [null, null],
])("roll street_number %j", (input, parsed) => {
  expect(parseRollHouse(input)).toEqual(parsed);
});
