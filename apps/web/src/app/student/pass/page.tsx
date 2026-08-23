"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import QRCode from "qrcode";
import { Shield, Clock, MapPin } from "lucide-react";

export default function ActivePassPage() {
  const [pass, setPass] = useState<any>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchPass = async () => {
      try {
        const data = await api.get<any>("/api/student/active-pass");
        setPass(data);

        // Generate QR code from token
        if (data.qrToken) {
          const url = await QRCode.toDataURL(data.qrToken, {
            width: 280,
            margin: 2,
            color: { dark: "#1e3a8a", light: "#ffffff" },
          });
          setQrDataUrl(url);
        }
      } catch (err: any) {
        setError(err.message || "No active pass found");
      } finally {
        setLoading(false);
      }
    };

    fetchPass();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-pulse text-gray-500">Loading pass...</div>
      </div>
    );
  }

  if (error || !pass) {
    return (
      <div className="max-w-lg mx-auto text-center py-12">
        <p className="text-gray-600">{error || "No active pass available"}</p>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    APPROVED: "bg-success-500",
    ACTIVE: "bg-success-500",
    OUTSIDE: "bg-primary-500",
  };

  return (
    <div className="max-w-md mx-auto">
      {/* Digital Gate Pass Card */}
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="bg-primary-900 text-white p-5 text-center">
          <h1 className="text-lg font-bold tracking-wide">CAMPUSGATE</h1>
          <p className="text-primary-200 text-xs mt-1">DIGITAL GATE PASS</p>
        </div>

        {/* Student Info */}
        <div className="p-5 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">
            {pass.student?.name}
          </h2>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
            <span>{pass.student?.enrollmentNo}</span>
            <span>•</span>
            <span>{pass.student?.department?.name}</span>
          </div>
        </div>

        {/* Pass Details */}
        <div className="p-5 space-y-3 text-sm border-b border-gray-100">
          <div className="flex justify-between">
            <span className="text-gray-500">Reason</span>
            <span className="font-medium">
              {pass.reason?.label}
              {pass.customReason && ` - ${pass.customReason}`}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Exit</span>
            <span className="font-medium">
              {new Date(pass.requestedExit).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Expected Return</span>
            <span className="font-medium">
              {new Date(pass.expectedReturn).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Approved By</span>
            <span className="font-medium">{pass.approvedBy?.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Pass #</span>
            <span className="font-mono text-xs">{pass.passNumber}</span>
          </div>
        </div>

        {/* Status */}
        <div className="p-5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${statusColors[pass.status] || "bg-gray-400"}`}
            />
            <span className="font-semibold text-sm">
              {pass.status === "APPROVED" || pass.status === "ACTIVE"
                ? "AUTHORIZED FOR EXIT"
                : pass.status === "OUTSIDE"
                  ? "CURRENTLY OUTSIDE"
                  : pass.status}
            </span>
          </div>
        </div>

        {/* QR Code */}
        <div className="p-6 flex flex-col items-center">
          {qrDataUrl ? (
            <>
              <img
                src={qrDataUrl}
                alt="Gate Pass QR Code"
                className="w-56 h-56"
              />
              <p className="text-xs text-gray-400 mt-3 flex items-center gap-1">
                <Shield className="w-3 h-3" />
                Show this QR at the gate
              </p>
            </>
          ) : (
            <p className="text-gray-500">QR code not available</p>
          )}
        </div>
      </div>
    </div>
  );
}
