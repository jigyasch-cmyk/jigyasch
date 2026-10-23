import { useEffect, useState } from "react";
import { Plus, Power, UserRoundCheck, Pencil } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

const emptyPerms = {
  customers: ["view", "manage"],
  drivers: ["view", "approve_reject"],
  vehicles: ["view", "manage"],
  drop_places: ["view", "add", "edit", "enable_disable"],
  bookings: ["view", "manage_status", "live_trip"],
  commission: ["view", "manage"],
  payments: ["view", "verify"],
  fares: ["view", "manage"],
  complaints: ["view", "reply"],
  reports: ["view"],
};

const areas = Object.keys(emptyPerms);

const defaultVehicles = [
  "E-Rickshaw",
  "Tata Ace",
  "Tempo",
  "Tractor",
];

const clonePermissions = (permissions = {}) =>
  Object.fromEntries(
    Object.entries(emptyPerms).map(([area, defaults]) => {
      const saved = permissions[area];

      const values = Array.isArray(saved)
        ? [...saved]
        : [...defaults];

      // Old vehicle approval permission becomes the new manage permission.
      const normalized =
        area === "vehicles"
          ? values.map((p) =>
              p === "approve_reject" ? "manage" : p
            )
          : values;

      return [area, [...new Set(normalized)]];
    })
  );

const blank = () => ({
  name: "",
  mobile: "",
  manager_id: "",
  password: "",
  pickup_pins: "",
  commission_pct: 10,
  permissions: clonePermissions(),
  active: true,
});

export default function ManagerAdminView() {
  const [rows, setRows] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank());

  const [fareRows, setFareRows] = useState([]);
  const [discount, setDiscount] = useState(0);
  const [vehicleCategories, setVehicleCategories] =
    useState(defaultVehicles);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingFare, setSavingFare] = useState(false);

  const hdrs = {
    headers: { "x-role": "admin" },
  };

  // Load managers
  const load = async () => {
    try {
      const res = await api.get("/admin/managers", hdrs);
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Failed to load managers"
      );
    }
  };

  // Load built-in and admin-added vehicle categories
  const loadVehicleCategories = async () => {
    try {
      const res = await api.get("/vehicle-categories");

      const data = Array.isArray(res.data) ? res.data : [];

      const names = data
        .filter((category) => category.enabled !== false)
        .map((category) => category.name)
        .filter(
          (name) => typeof name === "string" && name.trim()
        )
        .map((name) => name.trim());

      setVehicleCategories([
        ...new Set([...defaultVehicles, ...names]),
      ]);
    } catch (e) {
      console.error("Vehicle category loading failed", e);
      // Keep built-in categories available if this request fails.
      toast.error(
        "Could not load custom vehicle categories. Default categories remain available."
      );
    }
  };

  useEffect(() => {
    load();
    loadVehicleCategories();
  }, []);

  const openAdd = () => {
    setEditing(null);
    setForm(blank());
    setFareRows([]);
    setDiscount(0);
    setShow(true);
  };

  // Open a manager and fetch existing settings
  const openEdit = async (manager) => {
    setEditing(manager.id);

    setForm({
      name: manager.name || "",
      mobile: manager.mobile || "",
      manager_id: manager.manager_id || "",
      password: "",
      pickup_pins: (manager.pickup_pins || []).join(", "),
      commission_pct: manager.commission_pct ?? 10,
      permissions: clonePermissions(manager.permissions || {}),
      active: !!manager.active,
    });

    setFareRows([]);
    setDiscount(0);
    setShow(true);
    setLoading(true);

    try {
      const [fareRes, discountRes] = await Promise.all([
        api.get(
          `/admin/manager-fare-settings/${manager.id}`,
          hdrs
        ),
        api.get(
          `/admin/manager-discounts/${manager.id}`,
          hdrs
        ),
      ]);

      setFareRows(
        Array.isArray(fareRes.data) ? fareRes.data : []
      );

      setDiscount(
        Number(discountRes.data?.discount_pct ?? 0)
      );
    } catch (e) {
      toast.error(
        e.response?.data?.detail ||
          "Could not load manager fare settings"
      );
    } finally {
      setLoading(false);
    }
  };

  // Add manager or update existing manager
  const save = async () => {
    if (
      !form.name.trim() ||
      !form.mobile.trim() ||
      !form.manager_id.trim()
    ) {
      toast.error("Name, mobile and Manager ID are required");
      return;
    }

    if (!/^\d{10}$/.test(form.mobile)) {
      toast.error("Enter a valid 10-digit mobile number");
      return;
    }

    if (!editing && form.password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    const commission = Number(form.commission_pct);

    if (
      !Number.isFinite(commission) ||
      commission < 0 ||
      commission > 100
    ) {
      toast.error("Commission must be between 0 and 100");
      return;
    }

    const pickupPins = form.pickup_pins
      .split(",")
      .map((pin) => pin.trim())
      .filter(Boolean);

    setSaving(true);

    try {
      if (editing) {
        const body = {
          pickup_pins: pickupPins,
          commission_pct: commission,
          permissions: form.permissions,
          active: form.active,
        };

        await api.patch(
          `/admin/managers/${editing}`,
          body,
          hdrs
        );

        toast.success("Manager permissions updated");
      } else {
        const body = {
          ...form,
          name: form.name.trim(),
          manager_id: form.manager_id.trim(),
          pickup_pins: pickupPins,
          commission_pct: commission,
        };

        await api.post("/admin/managers", body, hdrs);

        toast.success("Manager added successfully");
      }

      setShow(false);
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Save failed"
      );
    } finally {
      setSaving(false);
    }
  };

  // Enable or disable manager
  const toggle = async (manager) => {
    try {
      await api.patch(
        `/admin/managers/${manager.id}`,
        { active: !manager.active },
        hdrs
      );

      toast.success(
        manager.active ? "Manager disabled" : "Manager enabled"
      );

      await load();
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Failed to update manager"
      );
    }
  };

  // Resign manager
  const resign = async (manager) => {
    if (
      !window.confirm(
        `Resign/deactivate ${manager.name}?`
      )
    ) {
      return;
    }

    try {
      await api.patch(
        `/admin/managers/${manager.id}`,
        { resigned: true },
        hdrs
      );

      toast.success("Manager deactivated");
      await load();
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Failed to deactivate manager"
      );
    }
  };

  // Update manager permissions
  const setPerm = (area, permission, enabled) => {
    setForm((current) => {
      const currentPermissions =
        current.permissions[area] || [];

      const updatedPermissions = enabled
        ? currentPermissions.includes(permission)
          ? currentPermissions
          : [...currentPermissions, permission]
        : currentPermissions.filter(
            (item) => item !== permission
          );

      return {
        ...current,
        permissions: {
          ...current.permissions,
          [area]: updatedPermissions,
        },
      };
    });
  };

  // Update only the fare field the admin edits
  const updateFare = (vehicleType, field, value) => {
    const numberValue = Number(value);

    setFareRows((current) => {
      const existing = current.find(
        (row) => row.vehicle_type === vehicleType
      );

      const row = existing || {
        vehicle_type: vehicleType,
        base_fare: 0,
        per_km: 0,
        commission_pct: Number(form.commission_pct || 10),
      };

      const updated = {
        ...row,
        vehicle_type: vehicleType,
        [field]: numberValue,
      };

      return [
        ...current.filter(
          (item) => item.vehicle_type !== vehicleType
        ),
        updated,
      ];
    });
  };

  // Save existing/edited fares and discount
  const saveFareDiscount = async () => {
    if (!editing) {
      toast.error("Save the manager before setting fares");
      return;
    }

    const discountValue = Number(discount);

    if (
      !Number.isFinite(discountValue) ||
      discountValue < 0 ||
      discountValue > 100
    ) {
      toast.error("Discount must be between 0 and 100");
      return;
    }

    // Validate every row that will actually be saved.
    for (const row of fareRows) {
      const baseFare = Number(row.base_fare ?? 0);
      const perKm = Number(row.per_km ?? 0);
      const commission = Number(
        row.commission_pct ?? form.commission_pct ?? 10
      );

      if (
        !Number.isFinite(baseFare) ||
        !Number.isFinite(perKm) ||
        !Number.isFinite(commission) ||
        baseFare < 0 ||
        perKm < 0 ||
        commission < 0 ||
        commission > 100
      ) {
        toast.error(
          `Invalid fare or commission for ${row.vehicle_type}`
        );
        return;
      }
    }

    setSavingFare(true);

    try {
      for (const vehicleType of vehicleCategories) {
        const row = fareRows.find(
          (item) => item.vehicle_type === vehicleType
        );

        // Critical: don't replace an untouched/missing fare with zero.
        if (!row) continue;

        await api.put(
          `/admin/manager-fare-settings/${editing}/${encodeURIComponent(
            vehicleType
          )}`,
          {
            base_fare: Number(row.base_fare ?? 0),
            per_km: Number(row.per_km ?? 0),
            commission_pct: Number(
              row.commission_pct ??
                form.commission_pct ??
                10
            ),
          },
          hdrs
        );
      }

      await api.put(
        `/admin/manager-discounts/${editing}`,
        { discount_pct: discountValue },
        hdrs
      );

      // Refresh persisted values after successful save.
      const [fareRes, discountRes] = await Promise.all([
        api.get(
          `/admin/manager-fare-settings/${editing}`,
          hdrs
        ),
        api.get(
          `/admin/manager-discounts/${editing}`,
          hdrs
        ),
      ]);

      setFareRows(
        Array.isArray(fareRes.data) ? fareRes.data : []
      );

      setDiscount(
        Number(discountRes.data?.discount_pct ?? 0)
      );

      toast.success("Manager fare and discount saved");
    } catch (e) {
      toast.error(
        e.response?.data?.detail ||
          e.message ||
          "Could not save manager fare settings"
      );
    } finally {
      setSavingFare(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold">
            Managers
          </h2>
          <p className="text-sm text-gray-500">
            Each manager gets separate Pickup PINs and permissions.
          </p>
        </div>

        <button
          type="button"
          className="brand-btn"
          onClick={openAdd}
        >
          <Plus className="h-4 w-4 inline" /> Add Manager
        </button>
      </div>

      {show && (
        <div className="card space-y-4">
          <div className="font-semibold">
            {editing ? "Edit Manager" : "Add Manager"}
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            {[
              ["Manager Name", "name"],
              ["Mobile", "mobile"],
              ["Manager ID", "manager_id"],
            ].map(([placeholder, key]) => (
              <input
                key={key}
                className="field"
                placeholder={placeholder}
                value={form[key]}
                disabled={
                  !!editing &&
                  (key === "mobile" || key === "manager_id")
                }
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    [key]:
                      key === "mobile"
                        ? event.target.value
                            .replace(/\D/g, "")
                            .slice(0, 10)
                        : event.target.value,
                  }))
                }
              />
            ))}

            {!editing && (
              <input
                className="field"
                type="password"
                autoComplete="new-password"
                placeholder="Password (minimum 6 characters)"
                value={form.password}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
              />
            )}

            <input
              className="field"
              placeholder="Assigned Pickup PIN(s), comma separated"
              value={form.pickup_pins}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  pickup_pins: event.target.value,
                }))
              }
            />

            <input
              className="field"
              type="number"
              min="0"
              max="100"
              placeholder="Commission %"
              value={form.commission_pct}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  commission_pct: event.target.value,
                }))
              }
            />
          </div>

          <div>
            <div className="font-semibold mb-2">
              Admin-controlled permissions
            </div>

            <div className="grid md:grid-cols-2 gap-2">
              {areas.map((area) => (
                <div
                  key={area}
                  className="border rounded-xl p-3"
                >
                  <div className="font-semibold capitalize">
                    {area.replace(/_/g, " ")}
                  </div>

                  <div className="flex flex-wrap gap-2 mt-2">
                    {emptyPerms[area].map((permission) => (
                      <label
                        key={permission}
                        className="text-xs flex gap-1 items-center"
                      >
                        <input
                          type="checkbox"
                          checked={(
                            form.permissions[area] || []
                          ).includes(permission)}
                          onChange={(event) =>
                            setPerm(
                              area,
                              permission,
                              event.target.checked
                            )
                          }
                        />
                        {area === "vehicles" && permission === "approve_reject" 
                          ? "manage"
                          : permission}
                        
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {editing && (
            <div className="border rounded-xl p-3 space-y-3">
              <div className="font-semibold">
                Manager-wise Fare & Discount (Admin Only)
              </div>

              {loading ? (
                <p className="text-sm text-gray-500">
                  Loading saved fares...
                </p>
              ) : (
                <>
                  <p className="text-xs text-gray-500">
                    Existing saved fares are loaded from the backend.
                    Edit a category to add or change its fare.
                  </p>

                  <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-2">
                    {vehicleCategories.map((vehicleType) => {
                      const row = fareRows.find(
                        (item) =>
                          item.vehicle_type === vehicleType
                      );

                      return (
                        <div
                          key={vehicleType}
                          className="border rounded-lg p-2"
                        >
                          <div className="text-sm font-semibold mb-2">
                            {vehicleType}
                          </div>

                          <label className="text-xs text-gray-500">
                            Base Fare
                          </label>

                          <input
                            className="field mb-2"
                            type="number"
                            min="0"
                            placeholder="Base Fare"
                            value={row?.base_fare ?? ""}
                            onChange={(event) =>
                              updateFare(
                                vehicleType,
                                "base_fare",
                                event.target.value
                              )
                            }
                          />

                          <label className="text-xs text-gray-500">
                            Per KM
                          </label>

                          <input
                            className="field"
                            type="number"
                            min="0"
                            placeholder="Per KM"
                            value={row?.per_km ?? ""}
                            onChange={(event) =>
                              updateFare(
                                vehicleType,
                                "per_km",
                                event.target.value
                              )
                            }
                          />

                          {!row && (
                            <p className="text-xs text-gray-500 mt-2">
                              No saved fare loaded. Enter both values
                              before saving this category.
                            </p>
                          )}
                        </div>
                      );
                    })}

                    <div className="border rounded-lg p-2">
                      <div className="text-sm font-semibold mb-2">
                        Discount (Manager-wise)
                      </div>

                      <label className="text-xs text-gray-500">
                        Discount %
                      </label>

                      <input
                        className="field"
                        type="number"
                        min="0"
                        max="100"
                        value={discount}
                        onChange={(event) =>
                          setDiscount(event.target.value)
                        }
                      />

                      <div className="text-xs text-gray-500 mt-2">
                        Admin only. Manager cannot edit discount.
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="h-10 px-4 rounded-lg bg-blue-50 text-blue-700 disabled:opacity-50"
                    onClick={saveFareDiscount}
                    disabled={savingFare || loading}
                  >
                    {savingFare
                      ? "Saving..."
                      : "Save Fare & Discount"}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">

            <button
          type="button"
          className="brand-btn"
          onClick={save}
          disabled={saving}
        >
          {saving
            ? "Saving..."
            : editing
            ? "Save Permissions"
            : "Save Manager"}
        </button>

        <button
          type="button"
          className="h-10 px-4 rounded-lg bg-gray-100"
          onClick={() => {
            setShow(false);
            setEditing(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )}

  <div className="card overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-gray-500">
          <th className="py-2">Manager</th>
          <th>Manager ID</th>
          <th>Pickup PIN(s)</th>
          <th>Commission</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>

      <tbody>
        {rows.map((manager) => (
          <tr key={manager.id} className="border-t">
            <td className="py-3">
              {manager.name}
              <div className="text-xs text-gray-400">
                {manager.mobile}
              </div>
            </td>

            <td>{manager.manager_id}</td>
            <td>{(manager.pickup_pins || []).join(", ")}</td>
            <td>{manager.commission_pct}%</td>

            <td>
              {manager.resigned
                ? "Resigned"
                : manager.active
                ? "Active"
                : "Inactive"}
            </td>

            <td className="py-2">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="h-9 px-3 rounded-lg bg-blue-50 text-blue-700"
                  onClick={() => openEdit(manager)}
                >
                  <Pencil className="h-4 w-4 inline" /> Permissions
                </button>

                <button
                  type="button"
                  className="h-9 px-3 rounded-lg bg-gray-100"
                  onClick={() => toggle(manager)}
                >
                  <Power className="h-4 w-4 inline" />{" "}
                  {manager.active ? "Disable" : "Enable"}
                </button>

                {!manager.resigned && (
                  <button
                    type="button"
                    className="h-9 px-3 rounded-lg bg-rose-50 text-rose-700"
                    onClick={() => resign(manager)}
                  >
                    <UserRoundCheck className="h-4 w-4 inline" /> Resign
                  </button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    {!rows.length && (
      <div className="text-gray-500 py-4">
        No managers yet.
      </div>
    )}
  </div>
</div>

);
}

 
