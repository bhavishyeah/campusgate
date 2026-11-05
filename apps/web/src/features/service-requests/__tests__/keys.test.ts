import { describe, it, expect } from "vitest";
import { serviceRequestKeys } from "../keys";

describe("serviceRequestKeys", () => {
  it("queue key includes every filter + page", () => {
    expect(serviceRequestKeys.queue({ status: "OPEN", requestTypeId: "t1", assigneeUserId: "u1", overdue: true, page: 2 })).toEqual([
      "service-requests",
      "queue",
      { status: "OPEN", requestTypeId: "t1", assigneeUserId: "u1", overdue: true, page: 2 },
    ]);
  });
  it("myRequests key includes status/type/page", () => {
    expect(serviceRequestKeys.myRequests({ status: "RESOLVED", requestTypeId: "t1", page: 1 })).toEqual([
      "service-requests",
      "me",
      "list",
      { status: "RESOLVED", requestTypeId: "t1", page: 1 },
    ]);
  });
  it("typeFields + overdue carry their param", () => {
    expect(serviceRequestKeys.typeFields("t1")).toEqual(["service-requests", "types", "fields", "t1"]);
    expect(serviceRequestKeys.reportOverdue(24)).toEqual(["service-requests", "reports", "overdue", { atRiskHours: 24 }]);
  });
  it("activeTypes + detail keys", () => {
    expect(serviceRequestKeys.activeTypes()).toEqual(["service-requests", "types", "active"]);
    expect(serviceRequestKeys.request("r1")).toEqual(["service-requests", "request", "r1"]);
    expect(serviceRequestKeys.myRequest("r1")).toEqual(["service-requests", "me", "detail", "r1"]);
  });
});
