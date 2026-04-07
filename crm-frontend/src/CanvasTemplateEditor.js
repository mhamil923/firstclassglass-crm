// File: src/CanvasTemplateEditor.js
//
// Canva-style free-form PDF template editor.
//
// Templates created here are stored in the existing `pdf_templates`
// table. The `config` JSON column carries:
//   { kind: "canvas", pageSize: "LETTER", canvasData: [...elements] }
//
// Elements are stored in canvas coordinates where 1 unit = 1/100 inch
// (so a letter-size page is 850 × 1100). The on-screen rendering scales
// by the user-selectable `zoom`.
//
// NOTE: Backend PDF generation for canvas templates is intentionally
// not yet implemented in server.js — that's a separate change. The
// editor saves/loads cleanly today; rendering to a real PDF is the
// next step.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import api from "./api";
import "./CanvasTemplateEditor.css";

/* ─── Constants ─────────────────────────────────────────────── */

const PAGE_W = 850; // 8.5" * 100
const PAGE_H = 1100; // 11"  * 100
const PPI = 100;
const GRID = 10;
const HISTORY_MAX = 50;

const FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "Roboto",
];

const DATA_FIELDS = [
  { value: "customerName", label: "Customer Name" },
  { value: "company", label: "Company" },
  { value: "billingAddress", label: "Billing Address" },
  { value: "projectName", label: "Project Name" },
  { value: "projectAddress", label: "Project Address" },
  { value: "poNumber", label: "PO Number" },
  { value: "date", label: "Date" },
  { value: "estimateTotal", label: "Estimate Total" },
  { value: "invoiceTotal", label: "Invoice Total" },
  { value: "lineItemsTable", label: "Line Items Table" },
  { value: "termsConditions", label: "Terms & Conditions" },
];

const DATA_FIELD_LABEL = Object.fromEntries(
  DATA_FIELDS.map((f) => [f.value, f.label])
);

// 8 resize handles, expressed as fractional positions of the element's bbox.
const HANDLES = [
  { id: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
  { id: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
  { id: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { id: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
  { id: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
  { id: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
  { id: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
  { id: "w", fx: 0, fy: 0.5, cursor: "ew-resize" },
];

const ZOOMS = [0.5, 0.75, 1, 1.25];

/* ─── Helpers ────────────────────────────────────────────────── */

const uid = () =>
  `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const snapTo = (v, gridOn) =>
  gridOn ? Math.round(v / GRID) * GRID : Math.round(v);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function nextZIndex(elements) {
  if (!elements.length) return 1;
  return Math.max(...elements.map((e) => e.zIndex || 1)) + 1;
}

/* ─── Element factories ──────────────────────────────────────── */

function createTextElement(zIndex) {
  return {
    id: uid(),
    type: "text",
    x: 60,
    y: 60,
    width: 240,
    height: 60,
    rotation: 0,
    zIndex,
    content: "Edit me",
    fontFamily: "Helvetica",
    fontSize: 14,
    fontWeight: "normal", // normal | bold
    fontStyle: "normal", // normal | italic
    textDecoration: "none", // none | underline
    color: "#000000",
    textAlign: "left",
    backgroundColor: "transparent",
    bgOpacity: 1,
    borderEnabled: false,
    borderColor: "#000000",
    borderWidth: 1,
  };
}

function createImageElement(src, zIndex) {
  return {
    id: uid(),
    type: "image",
    x: 60,
    y: 60,
    width: 160,
    height: 160,
    rotation: 0,
    zIndex,
    src: src || "",
    opacity: 1,
  };
}

function createLineElement(zIndex) {
  return {
    id: uid(),
    type: "line",
    x: 60,
    y: 60,
    width: 220,
    height: 2,
    rotation: 0,
    zIndex,
    orientation: "horizontal", // horizontal | vertical
    color: "#000000",
    thickness: 2,
    style: "solid", // solid | dashed | dotted
  };
}

function createRectElement(zIndex) {
  return {
    id: uid(),
    type: "rect",
    x: 60,
    y: 60,
    width: 220,
    height: 140,
    rotation: 0,
    zIndex,
    fillColor: "#ffffff",
    fillOpacity: 1,
    borderColor: "#000000",
    borderWidth: 1,
    borderRadius: 0,
  };
}

function createDataField(zIndex) {
  return {
    id: uid(),
    type: "dataField",
    x: 60,
    y: 60,
    width: 240,
    height: 40,
    rotation: 0,
    zIndex,
    field: "customerName",
    fontFamily: "Helvetica",
    fontSize: 14,
    fontWeight: "normal",
    fontStyle: "normal",
    color: "#000000",
    textAlign: "left",
  };
}

/* ─── Resize math ────────────────────────────────────────────── */

function resizeElement(el, handleId, dxCanvas, dyCanvas) {
  let { x, y, width, height } = el;
  const minW = 8;
  const minH = 4;

  // Apply movement to the appropriate edge(s)
  if (handleId.includes("w")) {
    x += dxCanvas;
    width -= dxCanvas;
  }
  if (handleId.includes("e")) {
    width += dxCanvas;
  }
  if (handleId.includes("n")) {
    y += dyCanvas;
    height -= dyCanvas;
  }
  if (handleId.includes("s")) {
    height += dyCanvas;
  }

  // Don't allow flipping past zero
  if (width < minW) {
    if (handleId.includes("w")) x -= minW - width;
    width = minW;
  }
  if (height < minH) {
    if (handleId.includes("n")) y -= minH - height;
    height = minH;
  }

  return { x, y, width, height };
}

/* ─── Element renderer (presentational) ──────────────────────── */

function ElementView({ el, selected, onPointerDown }) {
  const baseStyle = {
    position: "absolute",
    left: el.x,
    top: el.y,
    width: el.width,
    height: el.height,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    transformOrigin: "center center",
    zIndex: el.zIndex || 1,
    cursor: selected ? "move" : "pointer",
    boxSizing: "border-box",
  };

  if (el.type === "text") {
    return (
      <div
        className={`cte-el cte-el-text ${selected ? "is-selected" : ""}`}
        data-elid={el.id}
        style={{
          ...baseStyle,
          fontFamily: el.fontFamily,
          fontSize: el.fontSize,
          fontWeight: el.fontWeight,
          fontStyle: el.fontStyle,
          textDecoration: el.textDecoration,
          color: el.color,
          textAlign: el.textAlign,
          background:
            el.backgroundColor && el.backgroundColor !== "transparent"
              ? el.backgroundColor
              : "transparent",
          opacity: el.bgOpacity != null ? undefined : 1,
          border: el.borderEnabled
            ? `${el.borderWidth}px solid ${el.borderColor}`
            : "1px dashed transparent",
          padding: 4,
          whiteSpace: "pre-wrap",
          overflow: "hidden",
          userSelect: "none",
        }}
        onPointerDown={(e) => onPointerDown(e, el.id)}
      >
        {el.content || " "}
      </div>
    );
  }

  if (el.type === "image") {
    return (
      <div
        className={`cte-el cte-el-image ${selected ? "is-selected" : ""}`}
        data-elid={el.id}
        style={{
          ...baseStyle,
          opacity: el.opacity ?? 1,
          background: "rgba(0,0,0,0.04)",
          border: "1px dashed transparent",
        }}
        onPointerDown={(e) => onPointerDown(e, el.id)}
      >
        {el.src ? (
          <img
            src={el.src}
            alt=""
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              pointerEvents: "none",
              userSelect: "none",
            }}
          />
        ) : (
          <div className="cte-image-placeholder">No image</div>
        )}
      </div>
    );
  }

  if (el.type === "line") {
    const isHorizontal = el.orientation !== "vertical";
    const borderStyle =
      el.style === "dashed"
        ? "dashed"
        : el.style === "dotted"
        ? "dotted"
        : "solid";
    return (
      <div
        className={`cte-el cte-el-line ${selected ? "is-selected" : ""}`}
        data-elid={el.id}
        style={{
          ...baseStyle,
          background: "transparent",
          borderTop: isHorizontal
            ? `${el.thickness}px ${borderStyle} ${el.color}`
            : "none",
          borderLeft: !isHorizontal
            ? `${el.thickness}px ${borderStyle} ${el.color}`
            : "none",
          height: isHorizontal ? Math.max(el.thickness, 4) : el.height,
          width: isHorizontal ? el.width : Math.max(el.thickness, 4),
        }}
        onPointerDown={(e) => onPointerDown(e, el.id)}
      />
    );
  }

  if (el.type === "rect") {
    return (
      <div
        className={`cte-el cte-el-rect ${selected ? "is-selected" : ""}`}
        data-elid={el.id}
        style={{
          ...baseStyle,
          background: el.fillColor,
          opacity: el.fillOpacity ?? 1,
          border: `${el.borderWidth}px solid ${el.borderColor}`,
          borderRadius: el.borderRadius || 0,
        }}
        onPointerDown={(e) => onPointerDown(e, el.id)}
      />
    );
  }

  if (el.type === "dataField") {
    return (
      <div
        className={`cte-el cte-el-data ${selected ? "is-selected" : ""}`}
        data-elid={el.id}
        style={{
          ...baseStyle,
          fontFamily: el.fontFamily,
          fontSize: el.fontSize,
          fontWeight: el.fontWeight,
          fontStyle: el.fontStyle,
          color: el.color,
          textAlign: el.textAlign,
          padding: 4,
          background: "rgba(0, 122, 255, 0.06)",
          border: "1.5px dashed #007aff",
          borderRadius: 4,
          overflow: "hidden",
          userSelect: "none",
        }}
        onPointerDown={(e) => onPointerDown(e, el.id)}
      >
        {`{${DATA_FIELD_LABEL[el.field] || el.field}}`}
      </div>
    );
  }

  return null;
}

/* ─── Properties panel pieces ────────────────────────────────── */

function NumberInput({ label, value, onChange, min, max, step = 1 }) {
  return (
    <label className="cte-prop">
      <span>{label}</span>
      <input
        type="number"
        value={value ?? 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          onChange(v);
        }}
      />
    </label>
  );
}

function ColorInput({ label, value, onChange }) {
  return (
    <label className="cte-prop">
      <span>{label}</span>
      <input
        type="color"
        value={value || "#000000"}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SelectInput({ label, value, onChange, options }) {
  return (
    <label className="cte-prop">
      <span>{label}</span>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) =>
          typeof o === "string" ? (
            <option key={o} value={o}>
              {o}
            </option>
          ) : (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          )
        )}
      </select>
    </label>
  );
}

function ToggleButton({ active, onClick, children, title }) {
  return (
    <button
      type="button"
      title={title}
      className={`cte-toggle-btn ${active ? "is-active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function GeometrySection({ el, update }) {
  return (
    <>
      <h4 className="cte-prop-section">Position & Size</h4>
      <div className="cte-prop-row">
        <NumberInput
          label="X"
          value={Math.round(el.x)}
          onChange={(v) => update({ x: v })}
        />
        <NumberInput
          label="Y"
          value={Math.round(el.y)}
          onChange={(v) => update({ y: v })}
        />
      </div>
      <div className="cte-prop-row">
        <NumberInput
          label="W"
          value={Math.round(el.width)}
          min={1}
          onChange={(v) => update({ width: Math.max(1, v) })}
        />
        <NumberInput
          label="H"
          value={Math.round(el.height)}
          min={1}
          onChange={(v) => update({ height: Math.max(1, v) })}
        />
      </div>
      <NumberInput
        label="Rotation°"
        value={Math.round(el.rotation || 0)}
        onChange={(v) => update({ rotation: v })}
      />
    </>
  );
}

function LayerSection({ onMoveUp, onMoveDown, onFront, onBack }) {
  return (
    <>
      <h4 className="cte-prop-section">Layer</h4>
      <div className="cte-prop-row">
        <button type="button" className="cte-btn" onClick={onMoveUp}>
          Move Up
        </button>
        <button type="button" className="cte-btn" onClick={onMoveDown}>
          Move Down
        </button>
      </div>
      <div className="cte-prop-row">
        <button type="button" className="cte-btn" onClick={onFront}>
          To Front
        </button>
        <button type="button" className="cte-btn" onClick={onBack}>
          To Back
        </button>
      </div>
    </>
  );
}

function TextProps({ el, update }) {
  return (
    <>
      <h4 className="cte-prop-section">Text</h4>
      <label className="cte-prop">
        <span>Content</span>
        <textarea
          value={el.content || ""}
          rows={3}
          onChange={(e) => update({ content: e.target.value })}
        />
      </label>
      <SelectInput
        label="Font"
        value={el.fontFamily}
        onChange={(v) => update({ fontFamily: v })}
        options={FONT_FAMILIES}
      />
      <div className="cte-prop-row">
        <NumberInput
          label="Size"
          value={el.fontSize}
          min={4}
          max={256}
          onChange={(v) => update({ fontSize: clamp(v, 4, 256) })}
        />
        <ColorInput
          label="Color"
          value={el.color}
          onChange={(v) => update({ color: v })}
        />
      </div>
      <div className="cte-prop-row cte-prop-toggles">
        <ToggleButton
          title="Bold"
          active={el.fontWeight === "bold"}
          onClick={() =>
            update({ fontWeight: el.fontWeight === "bold" ? "normal" : "bold" })
          }
        >
          B
        </ToggleButton>
        <ToggleButton
          title="Italic"
          active={el.fontStyle === "italic"}
          onClick={() =>
            update({
              fontStyle: el.fontStyle === "italic" ? "normal" : "italic",
            })
          }
        >
          <span style={{ fontStyle: "italic" }}>I</span>
        </ToggleButton>
        <ToggleButton
          title="Underline"
          active={el.textDecoration === "underline"}
          onClick={() =>
            update({
              textDecoration:
                el.textDecoration === "underline" ? "none" : "underline",
            })
          }
        >
          <span style={{ textDecoration: "underline" }}>U</span>
        </ToggleButton>
      </div>
      <div className="cte-prop-row cte-prop-toggles">
        <ToggleButton
          title="Align Left"
          active={el.textAlign === "left"}
          onClick={() => update({ textAlign: "left" })}
        >
          ⯇
        </ToggleButton>
        <ToggleButton
          title="Align Center"
          active={el.textAlign === "center"}
          onClick={() => update({ textAlign: "center" })}
        >
          ⯀
        </ToggleButton>
        <ToggleButton
          title="Align Right"
          active={el.textAlign === "right"}
          onClick={() => update({ textAlign: "right" })}
        >
          ⯈
        </ToggleButton>
      </div>
      <h4 className="cte-prop-section">Background & Border</h4>
      <ColorInput
        label="Background"
        value={
          el.backgroundColor === "transparent" ? "#ffffff" : el.backgroundColor
        }
        onChange={(v) => update({ backgroundColor: v })}
      />
      <label className="cte-prop">
        <span>Transparent BG</span>
        <input
          type="checkbox"
          checked={el.backgroundColor === "transparent"}
          onChange={(e) =>
            update({
              backgroundColor: e.target.checked ? "transparent" : "#ffffff",
            })
          }
        />
      </label>
      <label className="cte-prop">
        <span>Border</span>
        <input
          type="checkbox"
          checked={!!el.borderEnabled}
          onChange={(e) => update({ borderEnabled: e.target.checked })}
        />
      </label>
      {el.borderEnabled && (
        <div className="cte-prop-row">
          <ColorInput
            label="Color"
            value={el.borderColor}
            onChange={(v) => update({ borderColor: v })}
          />
          <NumberInput
            label="Width"
            value={el.borderWidth}
            min={0}
            max={20}
            onChange={(v) => update({ borderWidth: clamp(v, 0, 20) })}
          />
        </div>
      )}
    </>
  );
}

function ImageProps({ el, update, onUpload }) {
  return (
    <>
      <h4 className="cte-prop-section">Image</h4>
      <label className="cte-prop cte-upload-row">
        <span>Upload</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            onUpload(file);
            e.target.value = "";
          }}
        />
      </label>
      <label className="cte-prop">
        <span>Opacity</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={el.opacity ?? 1}
          onChange={(e) => update({ opacity: Number(e.target.value) })}
        />
      </label>
      {el.src && (
        <button
          type="button"
          className="cte-btn"
          onClick={() => update({ src: "" })}
        >
          Remove Image
        </button>
      )}
    </>
  );
}

function LineProps({ el, update }) {
  return (
    <>
      <h4 className="cte-prop-section">Line</h4>
      <SelectInput
        label="Orientation"
        value={el.orientation}
        onChange={(v) => update({ orientation: v })}
        options={[
          { value: "horizontal", label: "Horizontal" },
          { value: "vertical", label: "Vertical" },
        ]}
      />
      <ColorInput
        label="Color"
        value={el.color}
        onChange={(v) => update({ color: v })}
      />
      <NumberInput
        label="Thickness"
        value={el.thickness}
        min={1}
        max={10}
        onChange={(v) => update({ thickness: clamp(v, 1, 10) })}
      />
      <SelectInput
        label="Style"
        value={el.style}
        onChange={(v) => update({ style: v })}
        options={[
          { value: "solid", label: "Solid" },
          { value: "dashed", label: "Dashed" },
          { value: "dotted", label: "Dotted" },
        ]}
      />
    </>
  );
}

function RectProps({ el, update }) {
  return (
    <>
      <h4 className="cte-prop-section">Rectangle</h4>
      <ColorInput
        label="Fill"
        value={el.fillColor}
        onChange={(v) => update({ fillColor: v })}
      />
      <label className="cte-prop">
        <span>Fill Opacity</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={el.fillOpacity ?? 1}
          onChange={(e) => update({ fillOpacity: Number(e.target.value) })}
        />
      </label>
      <ColorInput
        label="Border"
        value={el.borderColor}
        onChange={(v) => update({ borderColor: v })}
      />
      <NumberInput
        label="Border Width"
        value={el.borderWidth}
        min={0}
        max={20}
        onChange={(v) => update({ borderWidth: clamp(v, 0, 20) })}
      />
      <NumberInput
        label="Corner Radius"
        value={el.borderRadius}
        min={0}
        max={200}
        onChange={(v) => update({ borderRadius: Math.max(0, v) })}
      />
    </>
  );
}

function DataFieldProps({ el, update }) {
  return (
    <>
      <h4 className="cte-prop-section">Data Field</h4>
      <SelectInput
        label="Field"
        value={el.field}
        onChange={(v) => update({ field: v })}
        options={DATA_FIELDS}
      />
      <SelectInput
        label="Font"
        value={el.fontFamily}
        onChange={(v) => update({ fontFamily: v })}
        options={FONT_FAMILIES}
      />
      <div className="cte-prop-row">
        <NumberInput
          label="Size"
          value={el.fontSize}
          min={4}
          max={256}
          onChange={(v) => update({ fontSize: clamp(v, 4, 256) })}
        />
        <ColorInput
          label="Color"
          value={el.color}
          onChange={(v) => update({ color: v })}
        />
      </div>
      <div className="cte-prop-row cte-prop-toggles">
        <ToggleButton
          title="Bold"
          active={el.fontWeight === "bold"}
          onClick={() =>
            update({ fontWeight: el.fontWeight === "bold" ? "normal" : "bold" })
          }
        >
          B
        </ToggleButton>
        <ToggleButton
          title="Italic"
          active={el.fontStyle === "italic"}
          onClick={() =>
            update({
              fontStyle: el.fontStyle === "italic" ? "normal" : "italic",
            })
          }
        >
          <span style={{ fontStyle: "italic" }}>I</span>
        </ToggleButton>
      </div>
      <div className="cte-prop-row cte-prop-toggles">
        <ToggleButton
          title="Align Left"
          active={el.textAlign === "left"}
          onClick={() => update({ textAlign: "left" })}
        >
          ⯇
        </ToggleButton>
        <ToggleButton
          title="Align Center"
          active={el.textAlign === "center"}
          onClick={() => update({ textAlign: "center" })}
        >
          ⯀
        </ToggleButton>
        <ToggleButton
          title="Align Right"
          active={el.textAlign === "right"}
          onClick={() => update({ textAlign: "right" })}
        >
          ⯈
        </ToggleButton>
      </div>
    </>
  );
}

/* ─── Main component ─────────────────────────────────────────── */

export default function CanvasTemplateEditor() {
  const navigate = useNavigate();
  const params = useParams();
  const idParam = params.id; // undefined for /pdf-templates/canvas/new
  const isNew = !idParam;

  /* ── Core state ───────────────────────────────────────────── */
  const [templateName, setTemplateName] = useState("New Canvas Template");
  const [templateType, setTemplateType] = useState("both");
  const [elements, setElements] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [gridOn, setGridOn] = useState(true);
  const [marginsOn, setMarginsOn] = useState(true);
  const [bgColor, setBgColor] = useState("#ffffff");
  const [editingTextId, setEditingTextId] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);

  /* ── Undo/redo history ────────────────────────────────────── */
  // We snapshot the elements array. Strings are cheap and stable to compare.
  const historyRef = useRef({ past: [], future: [] });
  const skipHistoryRef = useRef(false);
  const lastElementsRef = useRef(elements);

  // Push to history whenever elements change (unless we're undoing/redoing).
  useEffect(() => {
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      lastElementsRef.current = elements;
      return;
    }
    const prev = lastElementsRef.current;
    if (prev === elements) return;
    const past = historyRef.current.past;
    past.push(JSON.stringify(prev));
    if (past.length > HISTORY_MAX) past.shift();
    historyRef.current.future = [];
    lastElementsRef.current = elements;
  }, [elements]);

  const undo = useCallback(() => {
    const past = historyRef.current.past;
    if (!past.length) return;
    const snap = past.pop();
    historyRef.current.future.push(JSON.stringify(lastElementsRef.current));
    skipHistoryRef.current = true;
    setElements(JSON.parse(snap));
  }, []);

  const redo = useCallback(() => {
    const future = historyRef.current.future;
    if (!future.length) return;
    const snap = future.pop();
    historyRef.current.past.push(JSON.stringify(lastElementsRef.current));
    skipHistoryRef.current = true;
    setElements(JSON.parse(snap));
  }, []);

  /* ── Load existing template ───────────────────────────────── */
  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/pdf-templates/${idParam}`);
        const tpl = res.data;
        let cfg = {};
        try {
          cfg =
            typeof tpl.config === "string"
              ? JSON.parse(tpl.config)
              : tpl.config || {};
        } catch {
          cfg = {};
        }
        if (cancelled) return;
        setTemplateName(tpl.name || "Untitled");
        setTemplateType(tpl.type || "both");
        if (cfg.kind === "canvas" && Array.isArray(cfg.canvasData)) {
          setElements(cfg.canvasData);
          if (cfg.bgColor) setBgColor(cfg.bgColor);
          // Reset history so the load isn't undoable into an empty state
          lastElementsRef.current = cfg.canvasData;
          historyRef.current = { past: [], future: [] };
        } else {
          alert(
            "This template was created with the classic builder and can't be opened in the canvas editor."
          );
          navigate("/pdf-templates");
          return;
        }
      } catch (err) {
        console.error("Failed to load template", err);
        alert("Failed to load template.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idParam, isNew, navigate]);

  /* ── Element CRUD ─────────────────────────────────────────── */
  const selected = useMemo(
    () => elements.find((e) => e.id === selectedId) || null,
    [elements, selectedId]
  );

  const updateElement = useCallback(
    (id, patch) => {
      setElements((prev) =>
        prev.map((el) => (el.id === id ? { ...el, ...patch } : el))
      );
    },
    [setElements]
  );

  const addElement = useCallback(
    (factory) => {
      setElements((prev) => {
        const el = factory(nextZIndex(prev));
        return [...prev, el];
      });
    },
    []
  );

  const addImageFromFile = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result;
      setElements((prev) => {
        const el = createImageElement(src, nextZIndex(prev));
        return [...prev, el];
      });
    };
    reader.readAsDataURL(file);
  }, []);

  const replaceImageOnElement = useCallback((id, file) => {
    const reader = new FileReader();
    reader.onload = () => {
      updateElement(id, { src: reader.result });
    };
    reader.readAsDataURL(file);
  }, [updateElement]);

  const deleteElement = useCallback(
    (id) => {
      setElements((prev) => prev.filter((el) => el.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    []
  );

  const duplicateElement = useCallback(
    (id) => {
      setElements((prev) => {
        const src = prev.find((e) => e.id === id);
        if (!src) return prev;
        const copy = {
          ...src,
          id: uid(),
          x: src.x + 12,
          y: src.y + 12,
          zIndex: nextZIndex(prev),
        };
        return [...prev, copy];
      });
    },
    []
  );

  // Layer reordering
  const moveLayer = useCallback(
    (id, where) => {
      setElements((prev) => {
        const arr = [...prev];
        const i = arr.findIndex((e) => e.id === id);
        if (i < 0) return prev;
        const sorted = [...arr].sort(
          (a, b) => (a.zIndex || 1) - (b.zIndex || 1)
        );
        const idx = sorted.findIndex((e) => e.id === id);
        if (where === "up" && idx < sorted.length - 1) {
          const a = sorted[idx];
          const b = sorted[idx + 1];
          const tmp = a.zIndex;
          a.zIndex = b.zIndex;
          b.zIndex = tmp;
        } else if (where === "down" && idx > 0) {
          const a = sorted[idx];
          const b = sorted[idx - 1];
          const tmp = a.zIndex;
          a.zIndex = b.zIndex;
          b.zIndex = tmp;
        } else if (where === "front") {
          const max = Math.max(...sorted.map((e) => e.zIndex || 1));
          const el = sorted.find((e) => e.id === id);
          if (el) el.zIndex = max + 1;
        } else if (where === "back") {
          const min = Math.min(...sorted.map((e) => e.zIndex || 1));
          const el = sorted.find((e) => e.id === id);
          if (el) el.zIndex = min - 1;
        }
        return sorted.map((s) => ({ ...s }));
      });
    },
    []
  );

  /* ── Drag / resize handling ───────────────────────────────── */
  const canvasRef = useRef(null);
  const dragStateRef = useRef(null);
  // dragStateRef holds: { mode, elementId, startMouseX, startMouseY, startEl }
  // mode is "move" or "resize:<handleId>"

  const screenToCanvas = useCallback(
    (clientX, clientY) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left) / zoom,
        y: (clientY - rect.top) / zoom,
      };
    },
    [zoom]
  );

  const onElementPointerDown = useCallback(
    (e, id) => {
      if (editingTextId) return;
      e.stopPropagation();
      // Don't start drag if user clicked an actual handle (handles call their own)
      const el = elements.find((x) => x.id === id);
      if (!el) return;
      setSelectedId(id);
      try {
        e.target.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      dragStateRef.current = {
        mode: "move",
        elementId: id,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startEl: { ...el },
      };
    },
    [elements, editingTextId]
  );

  const onHandlePointerDown = useCallback(
    (e, handleId) => {
      e.stopPropagation();
      e.preventDefault();
      if (!selected) return;
      try {
        e.target.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      dragStateRef.current = {
        mode: `resize:${handleId}`,
        elementId: selected.id,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startEl: { ...selected },
      };
    },
    [selected]
  );

  // Pointer move/up are attached to window so drags continue smoothly.
  useEffect(() => {
    const onMove = (e) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      const dx = (e.clientX - ds.startMouseX) / zoom;
      const dy = (e.clientY - ds.startMouseY) / zoom;
      if (ds.mode === "move") {
        const newX = snapTo(ds.startEl.x + dx, gridOn);
        const newY = snapTo(ds.startEl.y + dy, gridOn);
        updateElement(ds.elementId, { x: newX, y: newY });
      } else if (ds.mode.startsWith("resize:")) {
        const handleId = ds.mode.slice("resize:".length);
        const next = resizeElement(ds.startEl, handleId, dx, dy);
        updateElement(ds.elementId, {
          x: snapTo(next.x, gridOn),
          y: snapTo(next.y, gridOn),
          width: snapTo(next.width, gridOn),
          height: snapTo(next.height, gridOn),
        });
      }
    };
    const onUp = () => {
      dragStateRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [zoom, gridOn, updateElement]);

  /* ── Keyboard shortcuts ───────────────────────────────────── */
  useEffect(() => {
    const onKey = (e) => {
      // Ignore shortcuts while typing in form fields or editing text inline
      const tag = (e.target && e.target.tagName) || "";
      if (
        editingTextId ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        e.target?.isContentEditable
      ) {
        return;
      }
      const isCmd = e.ctrlKey || e.metaKey;

      if (isCmd && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (
        (isCmd && e.key.toLowerCase() === "y") ||
        (isCmd && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        redo();
        return;
      }
      if (isCmd && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (selectedId) duplicateElement(selectedId);
        return;
      }
      if (selectedId && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        deleteElement(selectedId);
        return;
      }
      if (
        selectedId &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx =
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy =
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const cur = elements.find((el) => el.id === selectedId);
        if (cur) updateElement(selectedId, { x: cur.x + dx, y: cur.y + dy });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selectedId,
    elements,
    deleteElement,
    duplicateElement,
    updateElement,
    undo,
    redo,
    editingTextId,
  ]);

  /* ── Inline text editing ──────────────────────────────────── */
  const startInlineEdit = useCallback(
    (id) => {
      const el = elements.find((e) => e.id === id);
      if (!el || el.type !== "text") return;
      setSelectedId(id);
      setEditingTextId(id);
    },
    [elements]
  );

  /* ── Save ─────────────────────────────────────────────────── */
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const config = {
        kind: "canvas",
        version: 1,
        pageSize: "LETTER",
        pageWidth: PAGE_W,
        pageHeight: PAGE_H,
        bgColor,
        canvasData: elements,
      };
      const body = {
        name: templateName.trim() || "Untitled Canvas",
        type: templateType,
        config,
      };
      let res;
      if (isNew) {
        res = await api.post("/pdf-templates", body);
        const newId = res?.data?.id;
        if (newId) navigate(`/pdf-templates/canvas/${newId}`, { replace: true });
      } else {
        res = await api.put(`/pdf-templates/${idParam}`, body);
      }
      // Visual confirmation
      // eslint-disable-next-line no-alert
      // (avoid noisy alert; rely on the button label flicker)
    } catch (err) {
      console.error("Save failed", err);
      alert(
        err?.response?.data?.error || "Failed to save template. See console."
      );
    } finally {
      setSaving(false);
    }
  }, [bgColor, elements, isNew, idParam, navigate, templateName, templateType]);

  /* ── Render: top toolbar ──────────────────────────────────── */
  const Toolbar = (
    <div className="cte-toolbar">
      <div className="cte-toolbar-left">
        <Link to="/pdf-templates" className="cte-back-link">
          ← Templates
        </Link>
        <input
          className="cte-name-input"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          placeholder="Template name"
        />
        <select
          className="cte-type-select"
          value={templateType}
          onChange={(e) => setTemplateType(e.target.value)}
        >
          <option value="both">For: Both</option>
          <option value="estimate">For: Estimate</option>
          <option value="invoice">For: Invoice</option>
        </select>
      </div>
      <div className="cte-toolbar-right">
        <button
          type="button"
          className={`cte-btn ${gridOn ? "is-active" : ""}`}
          onClick={() => setGridOn((v) => !v)}
          title="Toggle snap-to-grid"
        >
          Grid {gridOn ? "On" : "Off"}
        </button>
        <select
          className="cte-zoom-select"
          value={String(zoom)}
          onChange={(e) => setZoom(Number(e.target.value))}
        >
          {ZOOMS.map((z) => (
            <option key={z} value={String(z)}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
        <button
          type="button"
          className="cte-btn"
          onClick={() =>
            alert(
              "Live PDF preview for canvas templates is coming next — backend rendering is the next step."
            )
          }
          title="Preview"
        >
          Preview
        </button>
        <button
          type="button"
          className="cte-btn cte-btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );

  /* ── Render: left "Add Element" panel ─────────────────────── */
  const LeftPanel = (
    <aside className="cte-left">
      <h3 className="cte-side-title">Add Element</h3>
      <button
        type="button"
        className="cte-add-btn"
        onClick={() => addElement(createTextElement)}
      >
        ✎ Text
      </button>
      <label className="cte-add-btn cte-add-image">
        🖼 Image
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) addImageFromFile(f);
            e.target.value = "";
          }}
        />
      </label>
      <button
        type="button"
        className="cte-add-btn"
        onClick={() => addElement(createLineElement)}
      >
        ─ Line
      </button>
      <button
        type="button"
        className="cte-add-btn"
        onClick={() => addElement(createRectElement)}
      >
        ▭ Rectangle
      </button>
      <button
        type="button"
        className="cte-add-btn"
        onClick={() => addElement(createDataField)}
      >
        ⟨⟩ Data Field
      </button>

      <h3 className="cte-side-title" style={{ marginTop: 18 }}>
        Layers
      </h3>
      <div className="cte-layers">
        {elements.length === 0 && (
          <div className="cte-empty">No elements yet</div>
        )}
        {[...elements]
          .sort((a, b) => (b.zIndex || 1) - (a.zIndex || 1))
          .map((el) => (
            <button
              key={el.id}
              type="button"
              className={`cte-layer-row ${
                el.id === selectedId ? "is-selected" : ""
              }`}
              onClick={() => setSelectedId(el.id)}
            >
              <span className="cte-layer-type">{el.type}</span>
              <span className="cte-layer-name">
                {el.type === "text"
                  ? (el.content || "").slice(0, 24)
                  : el.type === "dataField"
                  ? DATA_FIELD_LABEL[el.field] || el.field
                  : el.id}
              </span>
            </button>
          ))}
      </div>
    </aside>
  );

  /* ── Render: right properties panel ───────────────────────── */
  const update = selected ? (patch) => updateElement(selected.id, patch) : () => {};

  const RightPanel = (
    <aside className="cte-right">
      {!selected ? (
        <>
          <h3 className="cte-side-title">Canvas</h3>
          <div className="cte-prop">
            <span>Page Size</span>
            <span style={{ fontWeight: 600 }}>Letter (8.5 × 11 in)</span>
          </div>
          <ColorInput label="Background" value={bgColor} onChange={setBgColor} />
          <label className="cte-prop">
            <span>Margin Guides</span>
            <input
              type="checkbox"
              checked={marginsOn}
              onChange={(e) => setMarginsOn(e.target.checked)}
            />
          </label>
          <label className="cte-prop">
            <span>Grid</span>
            <input
              type="checkbox"
              checked={gridOn}
              onChange={(e) => setGridOn(e.target.checked)}
            />
          </label>
          <p className="cte-help">
            Click an element to edit its properties. Double-click a text box to
            edit content. Delete removes selection. Ctrl+Z undo, Ctrl+Y redo,
            Ctrl+D duplicate. Arrow keys nudge.
          </p>
        </>
      ) : (
        <>
          <h3 className="cte-side-title">
            {selected.type === "text"
              ? "Text Box"
              : selected.type === "image"
              ? "Image"
              : selected.type === "line"
              ? "Line"
              : selected.type === "rect"
              ? "Rectangle"
              : "Data Field"}
          </h3>
          {selected.type === "text" && (
            <TextProps el={selected} update={update} />
          )}
          {selected.type === "image" && (
            <ImageProps
              el={selected}
              update={update}
              onUpload={(file) => replaceImageOnElement(selected.id, file)}
            />
          )}
          {selected.type === "line" && (
            <LineProps el={selected} update={update} />
          )}
          {selected.type === "rect" && (
            <RectProps el={selected} update={update} />
          )}
          {selected.type === "dataField" && (
            <DataFieldProps el={selected} update={update} />
          )}
          <GeometrySection el={selected} update={update} />
          <LayerSection
            onMoveUp={() => moveLayer(selected.id, "up")}
            onMoveDown={() => moveLayer(selected.id, "down")}
            onFront={() => moveLayer(selected.id, "front")}
            onBack={() => moveLayer(selected.id, "back")}
          />
          <div className="cte-prop-row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="cte-btn"
              onClick={() => duplicateElement(selected.id)}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="cte-btn cte-btn-danger"
              onClick={() => deleteElement(selected.id)}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </aside>
  );

  /* ── Render: canvas ───────────────────────────────────────── */
  const renderRulers = () => {
    // Inch markers — 8 across, 11 down. Pixel positions are pre-zoom.
    const xMarks = [];
    for (let i = 0; i <= 8; i++) {
      xMarks.push(
        <div
          key={`x${i}`}
          className="cte-ruler-mark cte-ruler-mark-x"
          style={{ left: i * PPI * zoom }}
        >
          <span>{i}″</span>
        </div>
      );
    }
    const yMarks = [];
    for (let i = 0; i <= 11; i++) {
      yMarks.push(
        <div
          key={`y${i}`}
          className="cte-ruler-mark cte-ruler-mark-y"
          style={{ top: i * PPI * zoom }}
        >
          <span>{i}″</span>
        </div>
      );
    }
    return (
      <>
        <div
          className="cte-ruler cte-ruler-top"
          style={{ width: PAGE_W * zoom }}
        >
          {xMarks}
        </div>
        <div
          className="cte-ruler cte-ruler-left"
          style={{ height: PAGE_H * zoom }}
        >
          {yMarks}
        </div>
      </>
    );
  };

  const sortedElements = useMemo(
    () => [...elements].sort((a, b) => (a.zIndex || 1) - (b.zIndex || 1)),
    [elements]
  );

  // Selection bounding box (in canvas coords) — used by handles overlay
  const selBox = selected
    ? {
        x: selected.x,
        y: selected.y,
        w: selected.width,
        h: selected.height,
      }
    : null;

  // Inline text editor overlay
  const editingEl =
    editingTextId && elements.find((e) => e.id === editingTextId);

  if (loading) {
    return <div className="cte-page cte-loading">Loading…</div>;
  }

  return (
    <div className="cte-page">
      {Toolbar}
      <div className="cte-workspace">
        {LeftPanel}
        <div className="cte-canvas-area">
          <div
            className="cte-canvas-wrap"
            style={{
              width: PAGE_W * zoom + 30,
              height: PAGE_H * zoom + 30,
            }}
          >
            {renderRulers()}
            <div
              ref={canvasRef}
              className="cte-canvas"
              onPointerDown={(e) => {
                // Click on empty canvas → deselect
                if (e.target === e.currentTarget) {
                  setSelectedId(null);
                  setEditingTextId(null);
                }
              }}
              onDoubleClick={(e) => {
                // Double-click on a text element starts inline edit
                const elNode = e.target.closest("[data-elid]");
                if (!elNode) return;
                const id = elNode.getAttribute("data-elid");
                startInlineEdit(id);
              }}
              style={{
                width: PAGE_W,
                height: PAGE_H,
                background: bgColor,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
                backgroundImage: gridOn
                  ? `radial-gradient(circle, rgba(0,0,0,0.18) 1px, transparent 1px)`
                  : undefined,
                backgroundSize: gridOn ? `${GRID}px ${GRID}px` : undefined,
              }}
            >
              {marginsOn && (
                <div
                  className="cte-margin-guides"
                  style={{
                    position: "absolute",
                    left: 50,
                    top: 50,
                    right: 50,
                    bottom: 50,
                    border: "1px dashed rgba(0,0,255,0.25)",
                    pointerEvents: "none",
                  }}
                />
              )}

              {sortedElements.map((el) => (
                <ElementView
                  key={el.id}
                  el={el}
                  selected={el.id === selectedId}
                  onPointerDown={onElementPointerDown}
                />
              ))}

              {/* Selection box + resize handles overlay */}
              {selBox && (
                <div
                  className="cte-sel-box"
                  style={{
                    position: "absolute",
                    left: selBox.x,
                    top: selBox.y,
                    width: selBox.w,
                    height: selBox.h,
                    border: "1.5px solid #007aff",
                    pointerEvents: "none",
                    boxSizing: "border-box",
                  }}
                >
                  {HANDLES.map((h) => (
                    <div
                      key={h.id}
                      className="cte-handle"
                      onPointerDown={(e) => onHandlePointerDown(e, h.id)}
                      style={{
                        position: "absolute",
                        left: `calc(${h.fx * 100}% - 5px)`,
                        top: `calc(${h.fy * 100}% - 5px)`,
                        width: 10,
                        height: 10,
                        background: "#fff",
                        border: "1.5px solid #007aff",
                        borderRadius: 2,
                        cursor: h.cursor,
                        pointerEvents: "auto",
                      }}
                    />
                  ))}
                </div>
              )}

              {/* Inline text editor overlay */}
              {editingEl && editingEl.type === "text" && (
                <textarea
                  autoFocus
                  className="cte-inline-textarea"
                  value={editingEl.content || ""}
                  onChange={(e) =>
                    updateElement(editingEl.id, { content: e.target.value })
                  }
                  onBlur={() => setEditingTextId(null)}
                  style={{
                    position: "absolute",
                    left: editingEl.x,
                    top: editingEl.y,
                    width: editingEl.width,
                    height: editingEl.height,
                    fontFamily: editingEl.fontFamily,
                    fontSize: editingEl.fontSize,
                    fontWeight: editingEl.fontWeight,
                    fontStyle: editingEl.fontStyle,
                    textDecoration: editingEl.textDecoration,
                    color: editingEl.color,
                    textAlign: editingEl.textAlign,
                    background:
                      editingEl.backgroundColor === "transparent"
                        ? "rgba(255,255,255,0.95)"
                        : editingEl.backgroundColor,
                    border: "2px solid #007aff",
                    padding: 4,
                    boxSizing: "border-box",
                    resize: "none",
                    outline: "none",
                  }}
                />
              )}
            </div>
          </div>
        </div>
        {RightPanel}
      </div>
    </div>
  );
}
