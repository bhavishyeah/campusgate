"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { CheckCircle } from "lucide-react";

interface Department {
  id: string;
  name: string;
  code: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    enrollmentNo: "",
    departmentId: "",
    program: "",
    semester: "",
    section: "",
  });

  useEffect(() => {
    api
      .get<Department[]>("/api/auth/departments")
      .then(setDepartments)
      .catch(() => setError("Could not load departments. Please try again later."));
  }, []);

  const update = (field: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => setForm({ ...form, [field]: e.target.value });

  const validate = () => {
    if (form.password.length < 8) return "Password must be at least 8 characters";
    if (form.password !== form.confirmPassword) return "Passwords do not match";
    if (!form.departmentId) return "Please select your department";
    const sem = parseInt(form.semester);
    if (isNaN(sem) || sem < 1 || sem > 12) return "Semester must be between 1 and 12";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/register", {
        name: form.name,
        email: form.email,
        password: form.password,
        role: "STUDENT",
        enrollmentNo: form.enrollmentNo,
        departmentId: form.departmentId,
        program: form.program,
        semester: parseInt(form.semester),
        section: form.section || undefined,
      });
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-900 via-primary-800 to-primary-950 p-4">
        <div className="w-full max-w-md card text-center">
          <CheckCircle className="w-14 h-14 text-success-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Registration Submitted
          </h2>
          <p className="text-sm text-gray-600 mb-6">
            Your account is awaiting administrator approval. You will be able to
            sign in once it has been approved.
          </p>
          <button
            className="btn-primary w-full"
            onClick={() => router.push("/login")}
          >
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-900 via-primary-800 to-primary-950 p-4 py-10">
      <div className="w-full max-w-lg mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">
            CAMPUSGATE
          </h1>
          <p className="text-primary-200 mt-2">Student Registration</p>
        </div>

        <div className="card">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="label">
                Full Name
              </label>
              <input
                id="name"
                type="text"
                className="input"
                value={form.name}
                onChange={update("name")}
                placeholder="Bhavishya Verma"
                required
                minLength={2}
                autoComplete="name"
              />
            </div>

            <div>
              <label htmlFor="email" className="label">
                Institutional Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={form.email}
                onChange={update("email")}
                placeholder="you@institution.edu"
                required
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="enrollmentNo" className="label">
                Enrollment Number
              </label>
              <input
                id="enrollmentNo"
                type="text"
                className="input"
                value={form.enrollmentNo}
                onChange={update("enrollmentNo")}
                placeholder="BCA2024001"
                required
              />
            </div>

            <div>
              <label htmlFor="departmentId" className="label">
                Department
              </label>
              <select
                id="departmentId"
                className="input"
                value={form.departmentId}
                onChange={update("departmentId")}
                required
              >
                <option value="">Select your department</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="program" className="label">
                  Program
                </label>
                <input
                  id="program"
                  type="text"
                  className="input"
                  value={form.program}
                  onChange={update("program")}
                  placeholder="BCA"
                  required
                />
              </div>

              <div>
                <label htmlFor="semester" className="label">
                  Semester
                </label>
                <input
                  id="semester"
                  type="number"
                  className="input"
                  value={form.semester}
                  onChange={update("semester")}
                  min={1}
                  max={12}
                  placeholder="4"
                  required
                />
              </div>

              <div>
                <label htmlFor="section" className="label">
                  Section
                </label>
                <input
                  id="section"
                  type="text"
                  className="input"
                  value={form.section}
                  onChange={update("section")}
                  placeholder="A"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="label">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={form.password}
                onChange={update("password")}
                placeholder="At least 8 characters"
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="label">
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                className="input"
                value={form.confirmPassword}
                onChange={update("confirmPassword")}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>

            {error && (
              <div
                className="bg-danger-50 border border-danger-500 text-danger-700 px-4 py-3 rounded-lg text-sm"
                role="alert"
              >
                {error}
              </div>
            )}

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? "Submitting..." : "Create Account"}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-6">
            Already registered?{" "}
            <a href="/login" className="text-primary-600 hover:underline">
              Sign in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
