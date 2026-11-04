import { describe, expect, it } from "vitest";
import { hostelKeys } from "../keys";

describe("hostelKeys.roomOptions", () => {
  it("differs per page", () => {
    expect(JSON.stringify(hostelKeys.roomOptions({ buildingId: "b", page: 1 }))).not.toBe(
      JSON.stringify(hostelKeys.roomOptions({ buildingId: "b", page: 2 })),
    );
  });
  it("differs per status and building", () => {
    expect(hostelKeys.roomOptions({ buildingId: "b", status: "AVAILABLE", page: 1 })).not.toEqual(
      hostelKeys.roomOptions({ buildingId: "b", page: 1 }),
    );
    expect(hostelKeys.roomOptions({ buildingId: "b", page: 1 })).not.toEqual(
      hostelKeys.roomOptions({ buildingId: "c", page: 1 }),
    );
  });
  it("is equal for equal input", () => {
    expect(hostelKeys.roomOptions({ buildingId: "b", status: "AVAILABLE", page: 2 })).toEqual(
      hostelKeys.roomOptions({ buildingId: "b", status: "AVAILABLE", page: 2 }),
    );
  });
  it("is prefixed by roomsAll so mutations invalidate it", () => {
    expect(hostelKeys.roomOptions({ buildingId: "b", page: 1 }).slice(0, 2)).toEqual(hostelKeys.roomsAll());
  });
});
