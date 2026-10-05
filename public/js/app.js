// IMDF Builder Application

class IMDFBuilder {
    constructor() {
        this.canvas = null;
        this.currentTool = 'select';
        this.currentLevel = null;
        this.levels = [];
        this.units = [];
        this.amenities = [];
        this.fixtures = [];
        this.openings = [];
        this.sections = [];
        this.buildingFootprint = null;   // single fabric polygon for the whole building
        this.selectedObject = null;
        this.projectId = null;

        // Polygon drawing state
        this.polyPoints = [];       // vertices collected so far
        this.polyLines = [];        // preview line objects on canvas
        this.polyDots = [];         // vertex dot objects on canvas
        this.previewLine = null;    // rubber-band line tracking mouse
        this.polyTarget = null;     // what we're currently drawing: 'unit'|'section'|'building-footprint'|'level-footprint'

        // Line drag-draw state (fixture / opening)
        this.lineDragStart = null;   // {x, y} anchor while dragging
        this.lineDragPreview = null; // temporary fabric.Line shown during drag

        // Polygon vertex editing
        this.vertexHandles = null;  // array of handle circles for selected polygon

        // Edge-snapping state
        this.snapEnabled = true;
        this.snapRadius = 12;       // pixels (canvas coords)
        this.snapCanvas = null;     // offscreen canvas for pixel sampling
        this.snapCtx = null;

        // Floor plan visibility toggle
        this.floorplanVisible = true;

        // Pan state
        this.isPanning = false;     // true while a pan drag is in progress
        this.panLastX  = 0;
        this.panLastY  = 0;
        this.spaceDown = false;     // Space bar held → temporary pan mode

        this.init();
    }

    init() {
        this.initPdfJs();
        this.initCanvas();
        this.attachEventListeners();
        this.updateCounts();
        this.initTheme();
        this.loadVersion();
    }

    async loadVersion() {
        try {
            const res = await fetch('/api/version');
            const { version } = await res.json();
            const el = document.getElementById('appVersion');
            if (el && version) el.textContent = `v${version}`;
        } catch {
            // Non-fatal: leave the placeholder if the version can't be fetched.
        }
    }

    initTheme() {
        // The inline head script already set data-theme; mirror it into the UI and
        // wire the toggle. Falls back to OS preference when nothing is stored.
        const saved = localStorage.getItem('imdf-theme');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.applyTheme(saved || (prefersDark ? 'dark' : 'light'));

        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                localStorage.setItem('imdf-theme', next);
                this.applyTheme(next);
            });
        }
    }

    applyTheme(theme) {
        const isDark = theme === 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        const icon = document.querySelector('.theme-toggle-icon');
        const label = document.querySelector('.theme-toggle-label');
        if (icon) icon.textContent = isDark ? '☀' : '☾';
        if (label) label.textContent = isDark ? 'Light' : 'Dark';

        // Keep the Fabric drawing surface in sync with the theme.
        if (this.canvas) {
            this.canvas.backgroundColor = isDark ? '#1e1e1e' : '#ffffff';
            this.canvas.renderAll();
        }
    }

    initPdfJs() {
        // pdf.js runs its parser in a web worker; point it at the vendored copy.
        if (window.pdfjsLib) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';
        }
    }

    initCanvas() {
        const canvasElement = document.getElementById('mainCanvas');
        const container = canvasElement.parentElement;
        
        // Set canvas size to fill container
        canvasElement.width = container.clientWidth;
        canvasElement.height = container.clientHeight;
        
        this.canvas = new fabric.Canvas('mainCanvas', {
            backgroundColor: '#ffffff',
            selection: true
        });

        // Handle window resize — update canvas dimensions and refit the background image
        window.addEventListener('resize', () => {
            const container = canvasElement.parentElement;
            this.canvas.setDimensions({
                width: container.clientWidth,
                height: container.clientHeight
            });
            this.refitBackground();
            this.buildSnapCanvas();
            this.canvas.renderAll();
        });

        // Canvas event handlers
        this.canvas.on('selection:created', (e) => this.handleSelection(e));
        this.canvas.on('selection:updated', (e) => this.handleSelection(e));
        this.canvas.on('selection:cleared', () => this.clearSelection());
        this.canvas.on('mouse:down', (e) => this.handleCanvasClick(e));
        this.canvas.on('mouse:move', (e) => this.handleCanvasMove(e));
        this.canvas.on('mouse:up',   (e) => this.handleCanvasUp(e));
        this.canvas.on('mouse:dblclick', (e) => this.handleCanvasDblClick(e));

        // Escape cancels an in-progress polygon
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.cancelPolygon();
        });

        // When a polygon vertex handle moves, update the polygon points
        this.canvas.on('object:moving', (e) => {
            const obj = e.target;
            if (obj && obj._vertexHandle) {
                this.updatePolygonVertex(obj);
            }
        });

        // ── Zoom on mouse wheel (zoom toward cursor) ──────────────
        this.canvas.on('mouse:wheel', (opt) => {
            const delta = opt.e.deltaY;
            let zoom = this.canvas.getZoom();
            zoom *= 0.999 ** delta;
            zoom = Math.min(Math.max(zoom, 0.05), 40);
            this.canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            this._updateZoomDisplay(zoom);
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        // ── Pan: middle-mouse drag ─────────────────────────────────
        this.canvas.on('mouse:down', (opt) => {
            const e = opt.e;
            const isMiddle = e.button === 1;
            const isSpaceDrag = this.spaceDown && e.button === 0;
            if (isMiddle || isSpaceDrag) {
                this.isPanning = true;
                this.panLastX  = e.clientX;
                this.panLastY  = e.clientY;
                this.canvas.defaultCursor = 'grabbing';
                this.canvas.setCursor('grabbing');
                e.preventDefault();
            }
        });

        this.canvas.on('mouse:move', (opt) => {
            if (!this.isPanning) return;
            const e = opt.e;
            const dx = e.clientX - this.panLastX;
            const dy = e.clientY - this.panLastY;
            this.panLastX = e.clientX;
            this.panLastY = e.clientY;
            this.canvas.relativePan({ x: dx, y: dy });
            this.canvas.renderAll();
        });

        this.canvas.on('mouse:up', (opt) => {
            if (this.isPanning) {
                this.isPanning = false;
                this.canvas.defaultCursor = this.spaceDown ? 'grab' : 'default';
                this.canvas.setCursor(this.spaceDown ? 'grab' : 'default');
            }
        });

        // ── Space bar → temporary pan mode ────────────────────────
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat && !this._isTyping(e)) {
                this.spaceDown = true;
                this.canvas.defaultCursor = 'grab';
                this.canvas.setCursor('grab');
                // Prevent page scroll while drawing
                e.preventDefault();
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.spaceDown = false;
                this.isPanning = false;
                this.canvas.defaultCursor = 'default';
                this.canvas.setCursor('default');
            }
        });
    }

    attachEventListeners() {
        // Project controls
        document.getElementById('newProjectBtn').addEventListener('click', () => this.newProject());
        document.getElementById('saveProjectBtn').addEventListener('click', () => this.saveProject());
        document.getElementById('loadProjectBtn').addEventListener('click', () => this.showLoadProjectModal());
        
        // Upload floor plan
        document.getElementById('uploadBtn').addEventListener('click', () => this.uploadFloorplan());
        
        // Level management
        document.getElementById('addLevelBtn').addEventListener('click', () => this.addLevel());
        
        // Tool selection
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tool = e.currentTarget.dataset.tool;
                this.setTool(tool);
            });
        });

        // Delete selected
        document.getElementById('deleteBtn').addEventListener('click', () => this.deleteSelected());

        // Canvas controls
        document.getElementById('zoomInBtn').addEventListener('click', () => this.zoomIn());
        document.getElementById('zoomOutBtn').addEventListener('click', () => this.zoomOut());
        document.getElementById('resetViewBtn').addEventListener('click', () => this.resetView());

        // Export
        document.getElementById('exportBtn').addEventListener('click', () => this.exportIMDF());

        // Snap toggle
        const snapToggle = document.getElementById('snapToggle');
        if (snapToggle) {
            snapToggle.addEventListener('change', (e) => {
                this.snapEnabled = e.target.checked;
                this.showToast(`Edge snapping ${this.snapEnabled ? 'on' : 'off'}`, 'info');
            });
        }

        // Floor plan visibility toggle
        const floorplanToggleBtn = document.getElementById('floorplanToggleBtn');
        if (floorplanToggleBtn) {
            floorplanToggleBtn.addEventListener('click', () => this.toggleFloorplan());
        }

        // Modal close
        document.querySelector('.close').addEventListener('click', () => {
            document.getElementById('loadProjectModal').style.display = 'none';
        });
    }

    setTool(tool) {
        // Cancel any in-progress polygon draw when switching tools
        if (this.polyPoints.length > 0) this.cancelPolygon();

        this.currentTool = tool;
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        
        if (tool === 'select') {
            this.canvas.selection = true;
            this.canvas.isDrawingMode = false;
            this.hideDrawingHint();
        } else {
            this.canvas.selection = false;
            this.canvas.isDrawingMode = false;
            if (tool === 'unit') {
                this.showDrawingHint('Click to place vertices — double-click or click near start to close the polygon. Esc to cancel.');
            } else if (tool === 'section') {
                this.showDrawingHint('Draw Section: click to place vertices, double-click or click near start to close. Esc to cancel.');
            } else if (tool === 'building-footprint') {
                this.showDrawingHint('Draw Building Footprint: click to place vertices, double-click or click near start to close. Esc to cancel.');
            } else if (tool === 'level-footprint') {
                this.showDrawingHint('Draw Level Footprint: click to place vertices, double-click or click near start to close. Esc to cancel.');
            } else if (tool === 'fixture') {
                this.showDrawingHint('Drag to draw fixture — hold Shift to lock horizontal/vertical.');
            } else if (tool === 'opening') {
                this.showDrawingHint('Drag to draw opening/door — hold Shift to lock horizontal/vertical.');
            } else {
                this.hideDrawingHint();
            }
        }
        
        this.updateCanvasInfo(`Tool: ${tool}`);
    }

    showDrawingHint(msg) {
        const el = document.getElementById('drawingHint');
        if (el) { el.textContent = msg; el.style.display = 'block'; }
    }

    hideDrawingHint() {
        const el = document.getElementById('drawingHint');
        if (el) el.style.display = 'none';
    }

    handleCanvasClick(event) {
        // Pan takes priority — let the mouse:down pan handler deal with it
        if (this.isPanning || this.spaceDown) return;
        if (!event.pointer || this.currentTool === 'select') return;
        // Ignore clicks on vertex handles
        if (event.target && event.target._vertexHandle) return;
        if (!this.currentLevel) {
            this.showToast('Please add and select a level first', 'error');
            return;
        }

        const raw = this.canvas.getPointer(event.e);
        const pointer = this.snapEnabled ? this.snapToEdge(raw) : raw;

        // Line-drag tools capture the start point here; finalisation is in mouse:up
        if (this.currentTool === 'fixture' || this.currentTool === 'opening') {
            this.lineDragStart = { x: pointer.x, y: pointer.y };
            return;
        }

        // Apply shift-lock for polygon tools — constrain against the previous vertex
        const polyTools = ['unit', 'section', 'building-footprint', 'level-footprint'];
        let finalPointer = pointer;
        if (polyTools.includes(this.currentTool) && this.polyPoints.length > 0) {
            const prev = this.polyPoints[this.polyPoints.length - 1];
            finalPointer = this._applyShiftLock(prev, pointer, event.e);
        }

        switch (this.currentTool) {
            case 'unit':
                this.handlePolygonClick(finalPointer, 'unit');
                break;
            case 'section':
                this.handlePolygonClick(finalPointer, 'section');
                break;
            case 'building-footprint':
                this.handlePolygonClick(finalPointer, 'building-footprint');
                break;
            case 'level-footprint':
                this.handlePolygonClick(finalPointer, 'level-footprint');
                break;
            case 'unit-rect':
                this.placeRectUnit(finalPointer);
                break;
            case 'amenity':
                this.placeAmenity(finalPointer);
                break;
        }
    }

    handleCanvasMove(event) {
        // While panning just hide the snap cursor — no drawing preview needed
        if (this.isPanning) {
            this.updateSnapCursor(null, false);
            return;
        }

        const raw = this.canvas.getPointer(event.e);
        const pos = this.snapEnabled ? this.snapToEdge(raw) : raw;

        // Show snap cursor dot
        this.updateSnapCursor(pos, raw !== pos || this.polyPoints.length > 0);

        // Live preview while drag-drawing a fixture or opening
        if (this.lineDragStart && (this.currentTool === 'fixture' || this.currentTool === 'opening')) {
            const end = this._applyShiftLock(this.lineDragStart, pos, event.e);
            const color = this.currentTool === 'fixture' ? '#6c757d' : '#dc3545';
            if (this.lineDragPreview) {
                this.lineDragPreview.set({ x1: this.lineDragStart.x, y1: this.lineDragStart.y, x2: end.x, y2: end.y });
            } else {
                this.lineDragPreview = new fabric.Line(
                    [this.lineDragStart.x, this.lineDragStart.y, end.x, end.y],
                    { stroke: color, strokeWidth: this.currentTool === 'fixture' ? 3 : 4,
                      strokeDashArray: [5, 3], selectable: false, evented: false, excludeFromExport: true }
                );
                this.canvas.add(this.lineDragPreview);
            }
            this.canvas.renderAll();
            return;
        }

        // Update rubber-band preview line while drawing polygon
        const polyTools = ['unit', 'section', 'building-footprint', 'level-footprint'];
        if (polyTools.includes(this.currentTool) && this.polyPoints.length > 0) {
            const last = this.polyPoints[this.polyPoints.length - 1];
            // Apply shift-lock so the preview matches what a click would place
            const previewEnd = this._applyShiftLock(last, pos, event.e);
            if (this.previewLine) {
                this.previewLine.set({ x1: last.x, y1: last.y, x2: previewEnd.x, y2: previewEnd.y });
            } else {
                this.previewLine = new fabric.Line([last.x, last.y, previewEnd.x, previewEnd.y], {
                    stroke: '#ff5c00',
                    strokeWidth: 1.5,
                    strokeDashArray: [4, 4],
                    selectable: false,
                    evented: false,
                    excludeFromExport: true
                });
                this.canvas.add(this.previewLine);
            }
            this.canvas.renderAll();
        }
    }

    handleCanvasDblClick(event) {
        const polyTools = ['unit', 'section', 'building-footprint', 'level-footprint'];
        if (polyTools.includes(this.currentTool) && this.polyPoints.length >= 3) {
            this.closePolygon(this.currentTool);
        }
    }

    handleCanvasUp(event) {
        // If we were panning, the pan mouse:up handler already cleared isPanning.
        // Either way, don't treat a pan-release as a line-drag finalization.
        if (!this.lineDragStart || this.isPanning) return;
        if (this.currentTool !== 'fixture' && this.currentTool !== 'opening') {
            this.lineDragStart = null;
            return;
        }

        // Remove preview
        if (this.lineDragPreview) {
            this.canvas.remove(this.lineDragPreview);
            this.lineDragPreview = null;
        }

        const raw = this.canvas.getPointer(event.e);
        const pos = this.snapEnabled ? this.snapToEdge(raw) : raw;
        const end = this._applyShiftLock(this.lineDragStart, pos, event.e);
        const start = this.lineDragStart;
        this.lineDragStart = null;

        // Require a minimum drag distance to avoid accidental zero-length lines
        const dist = Math.hypot(end.x - start.x, end.y - start.y);
        if (dist < 4) return;

        if (this.currentTool === 'fixture') {
            this._finalizeFixture(start, end);
        } else {
            this._finalizeOpening(start, end);
        }
    }

    // Constrain end point to 45° increments relative to start when Shift is held.
    // Snaps to the nearest of 0°, 45°, 90°, 135°, 180°, 225°, 270°, 315°.
    _applyShiftLock(start, end, nativeEvent) {
        if (!nativeEvent || !nativeEvent.shiftKey) return end;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const angle = Math.atan2(dy, dx);                  // radians, -π to π
        const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);  // nearest 45°
        const dist = Math.hypot(dx, dy);
        return {
            x: start.x + Math.round(Math.cos(snapped) * dist),
            y: start.y + Math.round(Math.sin(snapped) * dist)
        };
    }

    updateSnapCursor(snapped, show) {
        const el = document.getElementById('snapCursor');
        if (!el) return;
        if (!show) { el.style.display = 'none'; return; }
        // Convert canvas coords back to DOM coords
        const vpt = this.canvas.viewportTransform;
        const x = snapped.x * vpt[0] + vpt[4];
        const y = snapped.y * vpt[3] + vpt[5];
        el.style.left = x + 'px';
        el.style.top  = y + 'px';
        el.style.display = 'block';
    }

    // ── Polygon drawing ───────────────────────────────────────────

    handlePolygonClick(pointer, target) {
        const CLOSE_RADIUS = 14; // px — click near first vertex to close

        // If we're mid-draw on a different target, ignore
        if (this.polyTarget && this.polyTarget !== target) return;
        this.polyTarget = target;

        // Check if clicking near the first vertex to close the polygon
        if (this.polyPoints.length >= 3) {
            const first = this.polyPoints[0];
            const dx = pointer.x - first.x;
            const dy = pointer.y - first.y;
            if (Math.sqrt(dx*dx + dy*dy) < CLOSE_RADIUS) {
                this.closePolygon(target);
                return;
            }
        }

        // Add the vertex
        this.polyPoints.push({ x: pointer.x, y: pointer.y });

        // Draw a vertex dot
        const dot = new fabric.Circle({
            left: pointer.x,
            top: pointer.y,
            radius: 4,
            fill: this.polyPoints.length === 1 ? '#28a745' : '#ff5c00',
            stroke: '#fff',
            strokeWidth: 1.5,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
            excludeFromExport: true
        });
        this.canvas.add(dot);
        this.polyDots.push(dot);

        // Draw an edge from the previous vertex
        if (this.polyPoints.length > 1) {
            const prev = this.polyPoints[this.polyPoints.length - 2];
            const line = new fabric.Line([prev.x, prev.y, pointer.x, pointer.y], {
                stroke: '#ff5c00',
                strokeWidth: 1.5,
                selectable: false,
                evented: false,
                excludeFromExport: true
            });
            this.canvas.add(line);
            this.polyLines.push(line);
        }

        // Remove preview line so it gets recreated from the new last point
        if (this.previewLine) {
            this.canvas.remove(this.previewLine);
            this.previewLine = null;
        }

        const n = this.polyPoints.length;
        this.showDrawingHint(
            n === 1
                ? 'First vertex placed — keep clicking to add more. Double-click or click ● to close.'
                : `${n} vertices — double-click or click the green dot to close the polygon. Esc to cancel.`
        );
        this.canvas.renderAll();
    }

    closePolygon(target) {
        if (this.polyPoints.length < 3) return;

        // Clean up preview geometry
        this.cancelPolygonPreview();
        const points = this.polyPoints.map(p => ({ x: p.x, y: p.y }));
        this.polyPoints = [];
        this.polyTarget = null;

        if (target === 'building-footprint') {
            this._finalizeBuildingFootprint(points);
        } else if (target === 'level-footprint') {
            this._finalizeLevelFootprint(points);
        } else if (target === 'section') {
            this._finalizeSection(points);
        } else {
            this._finalizeUnit(points);
        }

        // Restore the appropriate drawing hint
        const hintMap = {
            'unit': 'Click to place vertices — double-click or click near start to close the polygon. Esc to cancel.',
            'section': 'Draw Section: click to place vertices, double-click or click near start to close. Esc to cancel.',
            'building-footprint': 'Draw Building Footprint: click to place vertices, double-click or click near start to close. Esc to cancel.',
            'level-footprint': 'Draw Level Footprint: click to place vertices, double-click or click near start to close. Esc to cancel.'
        };
        if (hintMap[this.currentTool]) this.showDrawingHint(hintMap[this.currentTool]);
        this.canvas.renderAll();
    }

    _finalizeUnit(points) {
        const poly = new fabric.Polygon(points, {
            fill: 'rgba(0, 120, 212, 0.3)',
            stroke: '#0078d4',
            strokeWidth: 2,
            selectable: true,
            evented: true,
            objectCaching: false
        });
        const unit = {
            id: this.generateUUID(),
            type: 'unit',
            name: `Unit ${this.units.length + 1}`,
            category: 'room',
            restriction: 'restricted',
            exchangeId: '',
            levelId: this.currentLevel.id,
            fabricObject: poly
        };
        poly.imdfData = unit;
        this.units.push(unit);
        this.canvas.add(poly);
        this._enforceZOrder();
        this.canvas.setActiveObject(poly);
        this.updateCounts();
    }

    _finalizeSection(points) {
        const poly = new fabric.Polygon(points, {
            fill: 'rgba(255, 165, 0, 0.2)',
            stroke: '#ff8c00',
            strokeWidth: 2,
            strokeDashArray: [6, 3],
            selectable: true,
            evented: true,
            objectCaching: false
        });
        const section = {
            id: this.generateUUID(),
            type: 'section',
            name: `Section ${this.sections.length + 1}`,
            category: 'unspecified',
            restriction: 'unrestricted',
            levelId: this.currentLevel.id,
            fabricObject: poly
        };
        poly.imdfData = section;
        this.sections.push(section);
        this.canvas.add(poly);
        this._enforceZOrder();
        this.canvas.setActiveObject(poly);
        this.updateCounts();
    }

    _finalizeBuildingFootprint(points) {
        // Remove old building footprint if present
        if (this.buildingFootprint) {
            this.canvas.remove(this.buildingFootprint.fabricObject);
        }
        const poly = new fabric.Polygon(points, {
            fill: 'rgba(120, 80, 200, 0.1)',
            stroke: '#7850c8',
            strokeWidth: 2,
            strokeDashArray: [8, 4],
            selectable: true,
            evented: true,
            objectCaching: false
        });
        this.buildingFootprint = {
            id: this.generateUUID(),
            type: 'building-footprint',
            fabricObject: poly
        };
        poly.imdfData = this.buildingFootprint;
        this.canvas.add(poly);
        this.canvas.setActiveObject(poly);
        // Send to back so it doesn't obscure other objects
        this.canvas.sendToBack(poly);
        this.showToast('Building footprint drawn', 'success');
    }

    _finalizeLevelFootprint(points) {
        if (!this.currentLevel) {
            this.showToast('Select a level first', 'error');
            return;
        }
        // Remove old footprint for this level if present
        if (this.currentLevel.footprint) {
            this.canvas.remove(this.currentLevel.footprint.fabricObject);
        }
        const poly = new fabric.Polygon(points, {
            fill: 'rgba(0, 180, 120, 0.1)',
            stroke: '#00b478',
            strokeWidth: 2,
            strokeDashArray: [8, 4],
            selectable: true,
            evented: true,
            objectCaching: false
        });
        const footprint = {
            id: this.generateUUID(),
            type: 'level-footprint',
            levelId: this.currentLevel.id,
            fabricObject: poly
        };
        poly.imdfData = footprint;
        this.currentLevel.footprint = footprint;
        this.canvas.add(poly);
        this.canvas.setActiveObject(poly);
        this.canvas.sendToBack(poly);
        this.showToast(`Level footprint drawn for ${this.currentLevel.name}`, 'success');
    }

    cancelPolygon() {
        if (this.polyPoints.length === 0) return;
        this.cancelPolygonPreview();
        this.polyPoints = [];
        this.polyTarget = null;
    }

    cancelPolygonPreview() {
        // Remove all temporary preview objects from canvas
        [...this.polyLines, ...this.polyDots].forEach(o => this.canvas.remove(o));
        if (this.previewLine) this.canvas.remove(this.previewLine);
        this.polyLines = [];
        this.polyDots = [];
        this.previewLine = null;
        this.canvas.renderAll();
    }

    // ── Snapping ──────────────────────────────────────────────────
    //
    // Priority order:
    //   1. Vertex snap   — exact hit on an existing polygon/rect vertex
    //   2. Edge snap     — nearest point on an existing polygon/rect edge
    //   3. Image snap    — nearest dark pixel in the background floor plan
    //
    // If none of the above find a candidate within snapRadius the raw pointer
    // is returned unchanged.

    // Build the offscreen sampling canvas whenever a new floor plan is loaded.
    // We draw the background image into an offscreen <canvas> at its natural
    // resolution so we can read pixel values without CORS issues (the image was
    // uploaded by the user and served from our own origin).
    buildSnapCanvas() {
        const bg = this.canvas.backgroundImage;
        if (!bg) { this.snapCanvas = null; this.snapCtx = null; return; }

        try {
            const el = bg._originalElement || bg.getElement && bg.getElement();
            if (!el) { this.snapCanvas = null; return; }

            const w = el.naturalWidth  || el.width  || 800;
            const h = el.naturalHeight || el.height || 600;

            this.snapCanvas = document.createElement('canvas');
            this.snapCanvas.width  = w;
            this.snapCanvas.height = h;
            this.snapCtx = this.snapCanvas.getContext('2d');
            this.snapCtx.drawImage(el, 0, 0, w, h);
        } catch (e) {
            // Cross-origin or tainted canvas — silently disable snapping
            this.snapCanvas = null;
            this.snapCtx = null;
        }
    }

    // Collect all world-space vertices from IMDF canvas objects (excluding
    // temporary drawing aids like preview lines, dots, and vertex handles).
    _collectObjectVertices() {
        const verts = [];
        this.canvas.getObjects().forEach(obj => {
            if (!obj.imdfData) return;           // skip preview / handle objects
            if (!obj.visible)  return;           // skip hidden (other-level) objects

            if (obj.type === 'polygon' && obj.points) {
                // Use the same world-transform logic as the exporter
                const matrix = obj.calcTransformMatrix();
                const ox = obj.pathOffset ? obj.pathOffset.x : 0;
                const oy = obj.pathOffset ? obj.pathOffset.y : 0;
                obj.points.forEach(p => {
                    const world = fabric.util.transformPoint(
                        new fabric.Point(p.x - ox, p.y - oy), matrix);
                    verts.push({ x: world.x, y: world.y });
                });
            } else if (obj.type === 'rect') {
                // Four corners via transform matrix
                const matrix = obj.calcTransformMatrix();
                const hw = (obj.width  * (obj.scaleX || 1)) / 2;
                const hh = (obj.height * (obj.scaleY || 1)) / 2;
                [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].forEach(([lx,ly]) => {
                    const world = fabric.util.transformPoint(
                        new fabric.Point(lx, ly), matrix);
                    verts.push({ x: world.x, y: world.y });
                });
            }
            // Lines (fixtures/openings) expose endpoints directly
            else if (obj.type === 'line') {
                verts.push({ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
            }
        });
        return verts;
    }

    // Collect edges as pairs of world-space points from all visible IMDF objects.
    _collectObjectEdges() {
        const edges = [];
        this.canvas.getObjects().forEach(obj => {
            if (!obj.imdfData) return;
            if (!obj.visible)  return;

            let worldPts = [];
            if (obj.type === 'polygon' && obj.points) {
                const matrix = obj.calcTransformMatrix();
                const ox = obj.pathOffset ? obj.pathOffset.x : 0;
                const oy = obj.pathOffset ? obj.pathOffset.y : 0;
                worldPts = obj.points.map(p => {
                    const w = fabric.util.transformPoint(
                        new fabric.Point(p.x - ox, p.y - oy), matrix);
                    return { x: w.x, y: w.y };
                });
                // Close the ring
                if (worldPts.length) worldPts.push(worldPts[0]);
            } else if (obj.type === 'rect') {
                const matrix = obj.calcTransformMatrix();
                const hw = (obj.width  * (obj.scaleX || 1)) / 2;
                const hh = (obj.height * (obj.scaleY || 1)) / 2;
                worldPts = [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh],[-hw,-hh]].map(([lx,ly]) => {
                    const w = fabric.util.transformPoint(
                        new fabric.Point(lx, ly), matrix);
                    return { x: w.x, y: w.y };
                });
            } else if (obj.type === 'line') {
                worldPts = [{ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }];
            }

            for (let i = 0; i + 1 < worldPts.length; i++) {
                edges.push([worldPts[i], worldPts[i + 1]]);
            }
        });
        return edges;
    }

    // Nearest point on a finite line segment [a→b] to point p.
    _closestPointOnSegment(p, a, b) {
        const abx = b.x - a.x, aby = b.y - a.y;
        const lenSq = abx * abx + aby * aby;
        if (lenSq === 0) return { x: a.x, y: a.y };
        let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return { x: a.x + t * abx, y: a.y + t * aby };
    }

    // Master snap entry point — replaces the old image-only snapToEdge.
    snapToEdge(pt) {
        if (!this.snapEnabled) return pt;
        const r = this.snapRadius;
        const r2 = r * r;

        // ── 1. Vertex snap ────────────────────────────────────────
        let bestDist2 = r2;
        let bestPt = null;

        for (const v of this._collectObjectVertices()) {
            const d2 = (v.x - pt.x) ** 2 + (v.y - pt.y) ** 2;
            if (d2 < bestDist2) {
                bestDist2 = d2;
                bestPt = { x: v.x, y: v.y };
            }
        }
        if (bestPt) return bestPt;

        // ── 2. Edge snap ──────────────────────────────────────────
        bestDist2 = r2;

        for (const [a, b] of this._collectObjectEdges()) {
            const closest = this._closestPointOnSegment(pt, a, b);
            const d2 = (closest.x - pt.x) ** 2 + (closest.y - pt.y) ** 2;
            if (d2 < bestDist2) {
                bestDist2 = d2;
                bestPt = closest;
            }
        }
        if (bestPt) return bestPt;

        // ── 3. Image edge snap ────────────────────────────────────
        if (!this.snapCtx || !this.canvas.backgroundImage) return pt;

        const bg = this.canvas.backgroundImage;
        const bgScaleX = bg.scaleX || 1;
        const bgScaleY = bg.scaleY || 1;
        const bgLeft   = bg.left   || 0;
        const bgTop    = bg.top    || 0;
        const bgW = (bg._originalElement
            ? (bg._originalElement.naturalWidth  || bg.width)
            : bg.width)  || 1;
        const bgH = (bg._originalElement
            ? (bg._originalElement.naturalHeight || bg.height)
            : bg.height) || 1;
        const bgOriginX = bgLeft - (bgW * bgScaleX) / 2;
        const bgOriginY = bgTop  - (bgH * bgScaleY) / 2;

        const imgX = (pt.x - bgOriginX) / bgScaleX;
        const imgY = (pt.y - bgOriginY) / bgScaleY;
        const imgRadius = this.snapRadius / Math.min(bgScaleX, bgScaleY);

        const rc = Math.ceil(imgRadius);
        const cx = Math.round(imgX), cy = Math.round(imgY);
        const x0 = Math.max(0, cx - rc), x1 = Math.min(this.snapCanvas.width  - 1, cx + rc);
        const y0 = Math.max(0, cy - rc), y1 = Math.min(this.snapCanvas.height - 1, cy + rc);

        if (x0 >= x1 || y0 >= y1) return pt;

        const imgData = this.snapCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        const pxData  = imgData.data;
        const stride  = (x1 - x0 + 1) * 4;

        // Pick the NEAREST qualifying dark pixel (not the darkest) so we land
        // consistently on the same edge of a wall regardless of draw order.
        let bestImgDist2 = imgRadius * imgRadius + 1;
        let foundImg = false;
        let bestImgX = pt.x, bestImgY = pt.y;

        for (let dy = 0; dy <= y1 - y0; dy++) {
            for (let dx = 0; dx <= x1 - x0; dx++) {
                const px = x0 + dx, py = y0 + dy;
                const d2 = (px - imgX) ** 2 + (py - imgY) ** 2;
                if (d2 > imgRadius * imgRadius) continue;

                const idx = dy * stride + dx * 4;
                const brightness = (pxData[idx] + pxData[idx+1] + pxData[idx+2]) / 3;
                const edgeScore  = (255 - brightness) / 255;

                if (edgeScore > 0.4 && d2 < bestImgDist2) {
                    bestImgDist2 = d2;
                    bestImgX = bgOriginX + px * bgScaleX;
                    bestImgY = bgOriginY + py * bgScaleY;
                    foundImg = true;
                }
            }
        }

        return foundImg ? { x: bestImgX, y: bestImgY } : pt;
    }

    // ── Rectangle unit (legacy quick-place) ──────────────────────
    placeRectUnit(pointer) {
        const rect = new fabric.Rect({
            left: pointer.x,
            top: pointer.y,
            width: 100,
            height: 100,
            fill: 'rgba(0, 120, 212, 0.3)',
            stroke: '#0078d4',
            strokeWidth: 2
        });

        const unit = {
            id: this.generateUUID(),
            type: 'unit',
            name: `Unit ${this.units.length + 1}`,
            category: 'room',
            restriction: 'restricted',
            exchangeId: '',
            levelId: this.currentLevel.id,
            fabricObject: rect
        };

        rect.imdfData = unit;
        this.units.push(unit);
        this.canvas.add(rect);
        this._enforceZOrder();
        this.updateCounts();
    }

    placeAmenity(pointer) {
        const circle = new fabric.Circle({
            left: pointer.x,
            top: pointer.y,
            radius: 15,
            fill: 'rgba(40, 167, 69, 0.5)',
            stroke: '#28a745',
            strokeWidth: 2
        });

        const amenity = {
            id: this.generateUUID(),
            type: 'amenity',
            name: `Amenity ${this.amenities.length + 1}`,
            category: 'seating',
            levelId: this.currentLevel.id,
            fabricObject: circle
        };

        circle.imdfData = amenity;
        this.amenities.push(amenity);
        this.canvas.add(circle);
        this._enforceZOrder();
        this.updateCounts();
    }

    _finalizeFixture(start, end) {
        const line = new fabric.Line([start.x, start.y, end.x, end.y], {
            stroke: '#6c757d',
            strokeWidth: 3
        });
        const fixture = {
            id: this.generateUUID(),
            type: 'fixture',
            category: 'wall',
            levelId: this.currentLevel.id,
            fabricObject: line
        };
        line.imdfData = fixture;
        this.fixtures.push(fixture);
        this.canvas.add(line);
        this._enforceZOrder();
        this.updateCounts();
    }

    _finalizeOpening(start, end) {
        const line = new fabric.Line([start.x, start.y, end.x, end.y], {
            stroke: '#dc3545',
            strokeWidth: 4
        });
        const opening = {
            id: this.generateUUID(),
            type: 'opening',
            category: 'door',
            levelId: this.currentLevel.id,
            fabricObject: line
        };
        line.imdfData = opening;
        this.openings.push(opening);
        this.canvas.add(line);
        this._enforceZOrder();
        this.updateCounts();
    }

    handleSelection(event) {
        const obj = event.selected[0];
        // If the user clicked a vertex handle, don't disturb the handle set
        if (obj && obj._vertexHandle) return;

        if (obj && obj.imdfData) {
            this.selectedObject = obj;
            this.showProperties(obj.imdfData);
        }
        // Show vertex handles when a polygon is selected in select mode
        if (obj && obj.type === 'polygon' && this.currentTool === 'select') {
            this.showVertexHandles(obj);
        } else {
            this.removeVertexHandles();
        }
    }

    clearSelection() {
        this.selectedObject = null;
        this.removeVertexHandles();
        document.getElementById('propertiesPanel').innerHTML = '<p class="hint">Select an item to edit its properties</p>';
    }

    showProperties(data) {
        const panel = document.getElementById('propertiesPanel');

        // Determine the item type label
        const typeMap = {
            unit: 'Unit / Room',
            amenity: 'Amenity',
            fixture: 'Fixture',
            opening: 'Opening / Door',
            section: 'Section',
            'building-footprint': 'Building Footprint',
            'level-footprint': 'Level Footprint'
        };
        const typeLabel = typeMap[data.type] || (data.levelId ? 'Item' : 'Unknown');

        let html = `<span class="prop-type-badge">${typeLabel}</span>`;

        // Vertex-edit tip for polygons
        if ((data.type === 'unit' || data.type === 'section' || data.type === 'building-footprint' || data.type === 'level-footprint') && this.selectedObject && this.selectedObject.type === 'polygon') {
            html += `<p class="hint" style="margin-bottom:8px">🔴 Drag the orange dots to reshape.</p>`;
        }

        // Read-only ID
        html += `
            <div class="property-field">
                <label>ID:</label>
                <input type="text" value="${data.id || ''}" readonly />
            </div>
        `;

        if (data.name !== undefined) {
            html += `
                <div class="property-field">
                    <label>Name:</label>
                    <input type="text" id="prop-name" value="${data.name || ''}" />
                </div>
            `;
        }

        if (data.category !== undefined) {
            const isSection = data.type === 'section';
            const unitOpts = [
                ['room','Room'],['office','Office'],['conference','Conference Room'],
                ['seating','Seating'],['restroom','Restroom'],['elevator','Elevator'],
                ['stairs','Stairs'],['wall','Wall'],['door','Door'],['unspecified','Unspecified']
            ];
            const sectionOpts = [
                ['unspecified','Unspecified'],['nonpublic','Non-Public'],['publiccorridor','Public Corridor'],
                ['stairway','Stairway'],['parking','Parking']
            ];
            const opts = (isSection ? sectionOpts : unitOpts)
                .map(([v,l]) => `<option value="${v}" ${data.category === v ? 'selected' : ''}>${l}</option>`)
                .join('');
            html += `
                <div class="property-field">
                    <label>Category:</label>
                    <select id="prop-category">${opts}</select>
                </div>
            `;
        }

        // Exchange ID field — only for units (which have a restriction property)
        if (data.exchangeId !== undefined) {
            html += `
                <div class="property-field">
                    <label>Exchange Room ID:</label>
                    <input type="text" id="prop-exchangeId" value="${data.exchangeId || ''}"
                           placeholder="e.g. room.building@contoso.com" />
                </div>
            `;
        }

        html += `
            <button id="updatePropertiesBtn" class="btn btn-primary" style="width: 100%; margin-top: 10px;">
                Update Properties
            </button>
        `;

        panel.innerHTML = html;

        // Auto-apply on blur for text inputs
        panel.querySelectorAll('input:not([readonly]), select').forEach(el => {
            el.addEventListener('change', () => this.updateSelectedProperties(data));
        });

        const updateBtn = document.getElementById('updatePropertiesBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => this.updateSelectedProperties(data));
        }
    }

    updateSelectedProperties(data) {
        const nameInput = document.getElementById('prop-name');
        const categoryInput = document.getElementById('prop-category');

        if (nameInput) data.name = nameInput.value;
        if (categoryInput) data.category = categoryInput.value;
        const exchangeInput = document.getElementById('prop-exchangeId');
        if (exchangeInput !== null) data.exchangeId = exchangeInput.value;

        this.showToast('Properties updated', 'success');
    }

    deleteSelected() {
        if (!this.selectedObject) {
            this.showToast('No object selected', 'info');
            return;
        }

        const data = this.selectedObject.imdfData;
        
        // Remove vertex handles before deleting
        this.removeVertexHandles();

        // Remove from canvas
        this.canvas.remove(this.selectedObject);

        // Remove from data arrays
        this.units = this.units.filter(u => u.id !== data.id);
        this.amenities = this.amenities.filter(a => a.id !== data.id);
        this.fixtures = this.fixtures.filter(f => f.id !== data.id);
        this.openings = this.openings.filter(o => o.id !== data.id);
        this.sections = this.sections.filter(s => s.id !== data.id);

        // Clear building/level footprint references
        if (data.type === 'building-footprint') this.buildingFootprint = null;
        if (data.type === 'level-footprint') {
            const lvl = this.levels.find(l => l.id === data.levelId);
            if (lvl) lvl.footprint = null;
        }

        this.selectedObject = null;
        this.clearSelection();
        this.updateCounts();
    }

    addLevel() {
        const name = document.getElementById('levelName').value || `Level ${this.levels.length}`;
        const ordinal = parseInt(document.getElementById('levelOrdinal').value) || this.levels.length;

        const level = {
            id: this.generateUUID(),
            name: name,
            ordinal: ordinal,
            short_name: ordinal.toString()
        };

        this.levels.push(level);
        this.renderLevelsList();
        this.updateCounts();

        // Auto-select the new level
        this.selectLevel(level);

        // Clear inputs
        document.getElementById('levelName').value = '';
        document.getElementById('levelOrdinal').value = this.levels.length;
    }

    renderLevelsList() {
        const list = document.getElementById('levelsList');
        list.innerHTML = '';

        this.levels.forEach(level => {
            const item = document.createElement('div');
            item.className = 'level-item';
            if (this.currentLevel && this.currentLevel.id === level.id) {
                item.classList.add('active');
            }
            item.innerHTML = `
                <span>${level.name} (${level.ordinal})</span>
                <button class="btn btn-danger btn-sm" onclick="app.removeLevel('${level.id}')">Remove</button>
            `;
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('btn')) {
                    this.selectLevel(level);
                }
            });
            list.appendChild(item);
        });
    }

    selectLevel(level) {
        this.currentLevel = level;
        this.renderLevelsList();
        this.updateCanvasInfo(`Current Level: ${level.name}`);
        this.updateLevelVisibility();
        // Swap background to this level's floor plan (or clear if none)
        this._applyLevelFloorplan(level);
    }

    _applyLevelFloorplan(level) {
        const img = level.floorplanImage || null;
        if (img) {
            this.loadFloorplanToCanvas(img).catch(() => {});
        } else {
            this.canvas.backgroundImage = null;
            this.snapCanvas = null;
            this.snapCtx = null;
            this.canvas.renderAll();
        }
        // Re-apply current visibility state after a floor plan swap
        this._applyFloorplanVisibility();
    }

    toggleFloorplan() {
        this.floorplanVisible = !this.floorplanVisible;
        this._applyFloorplanVisibility();
        const btn = document.getElementById('floorplanToggleBtn');
        if (btn) {
            btn.textContent = this.floorplanVisible ? '🖼 Hide Floor Plan' : '🖼 Show Floor Plan';
            btn.classList.toggle('active', !this.floorplanVisible);
            btn.blur();
        }
        this.showToast(`Floor plan ${this.floorplanVisible ? 'shown' : 'hidden'}`, 'info');
    }

    // Apply the current floorplanVisible state to the background image opacity.
    // The image object is kept intact (so snap still works) — only its opacity changes.
    _applyFloorplanVisibility() {
        const bg = this.canvas.backgroundImage;
        if (!bg) return;
        bg.set({ opacity: this.floorplanVisible ? 1 : 0 });
        this.canvas.renderAll();
    }

    updateLevelVisibility() {
        if (!this.currentLevel) return;
        const activeId = this.currentLevel.id;
        this.canvas.getObjects().forEach(obj => {
            if (!obj.imdfData) return;
            const d = obj.imdfData;
            if (d.type === 'building-footprint') {
                // Building footprint is always visible
                obj.set({ visible: true, evented: true, selectable: true });
            } else if (d.levelId) {
                const visible = d.levelId === activeId;
                obj.set({ visible, evented: visible, selectable: visible });
            }
        });
        this._enforceZOrder();
        this.canvas.discardActiveObject();
        this.canvas.renderAll();
    }

    // Ensure footprints always sit below units/sections/amenities/fixtures/openings.
    // Call this whenever the canvas object list changes (new object added, level switched).
    // Order from bottom to top: building-footprint → level-footprints → everything else.
    _enforceZOrder() {
        const objects = this.canvas.getObjects();

        // Collect footprints in desired bottom-to-top order
        const buildingFootprints = objects.filter(o => o.imdfData && o.imdfData.type === 'building-footprint');
        const levelFootprints    = objects.filter(o => o.imdfData && o.imdfData.type === 'level-footprint');

        // Send building footprints to absolute back first (they end up below level footprints)
        buildingFootprints.forEach(o => this.canvas.sendToBack(o));
        // Then send level footprints just above the building footprint
        levelFootprints.forEach(o => this.canvas.sendToBack(o));
        // Net result: building-footprint(s) at index 0, level-footprints above them,
        // all units/sections/amenities/fixtures/openings above those.
    }

    removeLevel(levelId) {
        // Remove level
        this.levels = this.levels.filter(l => l.id !== levelId);
        
        // Remove associated items from canvas
        const itemsToRemove = [];
        this.canvas.getObjects().forEach(obj => {
            if (obj.imdfData && obj.imdfData.levelId === levelId) {
                itemsToRemove.push(obj);
            }
        });
        itemsToRemove.forEach(obj => this.canvas.remove(obj));

        // Remove from data arrays
        this.units = this.units.filter(u => u.levelId !== levelId);
        this.amenities = this.amenities.filter(a => a.levelId !== levelId);
        this.fixtures = this.fixtures.filter(f => f.levelId !== levelId);
        this.openings = this.openings.filter(o => o.levelId !== levelId);
        this.sections = this.sections.filter(s => s.levelId !== levelId);

        if (this.currentLevel && this.currentLevel.id === levelId) {
            this.currentLevel = null;
        }

        this.renderLevelsList();
        this.updateCounts();
    }

    async uploadFloorplan() {
        const fileInput = document.getElementById('floorplanUpload');
        const file = fileInput.files[0];
        
        if (!file) {
            this.showToast('Please select a file first', 'error');
            return;
        }

        if (!this.currentLevel) {
            this.showToast('Please add and select a level first', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('floorplan', file);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            const result = await this.parseJsonResponse(response);

            if (response.ok && result.success) {
                // Store on the current level
                this.currentLevel.floorplanImage = result.path;
                await this.loadFloorplanToCanvas(result.path);
                fileInput.value = '';
                this.showToast(`Floor plan uploaded for ${this.currentLevel.name}`, 'success');
            } else {
                this.showToast('Upload failed: ' + (result.error || `HTTP ${response.status}`), 'error');
            }
        } catch (error) {
            this.showToast('Upload error: ' + error.message, 'error');
        }
    }

    // Parse a fetch response as JSON, tolerating a non-JSON body (e.g. an HTML error
    // page from a proxy or a crashed server) instead of throwing the confusing
    // "JSON.parse: unexpected character" error users reported in issue #4.
    async parseJsonResponse(response) {
        const text = await response.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return { error: `Server returned a non-JSON response (HTTP ${response.status})` };
        }
    }

    async loadFloorplanToCanvas(imageUrl) {
        // A PDF can't be drawn as an <img>; rasterize its first page first (issue #4).
        const isPdf = /\.pdf($|\?)/i.test(imageUrl);
        const isSvg = /\.svg($|\?)/i.test(imageUrl);

        if (isSvg) {
            await this.loadSvgToCanvas(imageUrl);
            return;
        }

        const sourceUrl = isPdf ? await this.renderPdfToDataUrl(imageUrl) : imageUrl;

        // Fabric v6 returns a Promise from fromURL (the old callback form is gone).
        const img = await fabric.Image.fromURL(sourceUrl);
        if (!img) {
            throw new Error('Failed to load floor plan image');
        }

        img.set({ selectable: false, evented: false });

        // Fabric v6: backgroundImage is a property; setBackgroundImage() was removed.
        this.canvas.backgroundImage = img;
        this.refitBackground();
        this.buildSnapCanvas();
        this._applyFloorplanVisibility();
        this.canvas.renderAll();
    }

    async renderPdfToDataUrl(pdfUrl) {
        if (!window.pdfjsLib) {
            throw new Error('PDF support failed to load. Please refresh and try again.');
        }
        const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
        const page = await pdf.getPage(1); // first page becomes the floor plan
        // Render at 2x so the background stays crisp when zoomed in.
        const viewport = page.getViewport({ scale: 2 });
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = viewport.width;
        tmpCanvas.height = viewport.height;
        await page.render({ canvasContext: tmpCanvas.getContext('2d'), viewport }).promise;
        return tmpCanvas.toDataURL('image/png');
    }

    // Re-scale and re-centre the background image to fill 90% of the current
    // canvas size.  Called after every resize so the floor plan tracks the window.
    refitBackground() {
        const bg = this.canvas.backgroundImage;
        if (!bg) return;

        // Natural dimensions — for a Fabric Image use width/height; for an SVG
        // Group use the original width/height stored on the object.
        const naturalW = bg._originalElement ? bg._originalElement.naturalWidth || bg.width : bg.width;
        const naturalH = bg._originalElement ? bg._originalElement.naturalHeight || bg.height : bg.height;
        const srcW = naturalW || bg.width || 1;
        const srcH = naturalH || bg.height || 1;

        const scale = Math.min(
            this.canvas.width  / srcW,
            this.canvas.height / srcH
        ) * 0.9;

        bg.scale(scale);
        bg.set({
            left: this.canvas.width  / 2,
            top:  this.canvas.height / 2,
            originX: 'center',
            originY: 'center'
        });
    }

    async loadSvgToCanvas(svgUrl) {
        // Fabric v6 exposes loadSVGFromURL on the util namespace.
        const loadFn = (fabric.util && fabric.util.loadSVGFromURL)
            ? fabric.util.loadSVGFromURL
            : fabric.loadSVGFromURL;

        if (!loadFn) {
            throw new Error('SVG loading not supported by this version of Fabric.js');
        }

        const { objects, options } = await new Promise((resolve, reject) => {
            loadFn(svgUrl, (objects, options) => {
                if (!objects) reject(new Error('Failed to parse SVG'));
                else resolve({ objects, options });
            });
        });

        const group = fabric.util.groupSVGElements(objects, options);
        group.set({ selectable: false, evented: false });

        this.canvas.backgroundImage = group;
        this.refitBackground();
        this.buildSnapCanvas();
        this._applyFloorplanVisibility();
        this.canvas.renderAll();
    }

    zoomIn() {
        this._zoomAroundCenter(this.canvas.getZoom() * 1.2);
    }

    zoomOut() {
        this._zoomAroundCenter(this.canvas.getZoom() / 1.2);
    }

    // Zoom toward the visible centre of the canvas so the content stays centred
    // when using the toolbar buttons (mouse-wheel zoom uses the cursor position).
    _zoomAroundCenter(newZoom) {
        newZoom = Math.min(Math.max(newZoom, 0.05), 40);
        const cx = this.canvas.getWidth()  / 2;
        const cy = this.canvas.getHeight() / 2;
        this.canvas.zoomToPoint({ x: cx, y: cy }, newZoom);
        this._updateZoomDisplay(newZoom);
    }

    _updateZoomDisplay(zoom) {
        const el = document.getElementById('zoomLevel');
        if (el) el.textContent = Math.round(zoom * 100) + '%';
    }

    resetView() {
        this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        this._updateZoomDisplay(1);
        this.canvas.renderAll();
    }

    async saveProject() {
        const projectName = document.getElementById('projectName').value || 'Untitled Project';
        
        const projectData = {
            projectName: projectName,
            venue: {
                name: projectName,
                coordinates: this.parseCoordinates(document.getElementById('venueCoords').value)
            },
            building: {
                name: document.getElementById('buildingName').value || 'Building',
                coordinates: this.getBuildingCoordinates()
            },
            units: this.units.map(u => ({
                id: u.id,
                name: u.name,
                category: u.category,
                restriction: u.restriction,
                exchangeId: u.exchangeId || '',
                levelId: u.levelId,
                coordinates: this.getObjectCoordinates(u.fabricObject),
                display_point: this.getDisplayPoint(u.fabricObject),
                canvasData: this._serializeUnit(u.fabricObject)
            })),
            amenities: this.amenities.map(a => ({
                id: a.id,
                name: a.name,
                category: a.category,
                levelId: a.levelId,
                coordinates: this.getPointCoordinates(a.fabricObject),
                canvasData: { left: a.fabricObject.left, top: a.fabricObject.top, radius: a.fabricObject.radius }
            })),
            fixtures: this.fixtures.map(f => ({
                id: f.id,
                category: f.category,
                levelId: f.levelId,
                geometryType: 'LineString',
                coordinates: this.getLineCoordinates(f.fabricObject),
                canvasData: { x1: f.fabricObject.x1, y1: f.fabricObject.y1, x2: f.fabricObject.x2, y2: f.fabricObject.y2 }
            })),
            openings: this.openings.map(o => ({
                id: o.id,
                category: o.category,
                levelId: o.levelId,
                coordinates: this.getLineCoordinates(o.fabricObject),
                canvasData: { x1: o.fabricObject.x1, y1: o.fabricObject.y1, x2: o.fabricObject.x2, y2: o.fabricObject.y2 }
            })),
            sections: this.sections.map(s => ({
                id: s.id,
                name: s.name,
                category: s.category,
                restriction: s.restriction,
                levelId: s.levelId,
                coordinates: this.getObjectCoordinates(s.fabricObject),
                canvasData: this._serializeUnit(s.fabricObject)
            })),
            buildingFootprint: this.buildingFootprint ? {
                id: this.buildingFootprint.id,
                coordinates: this.getObjectCoordinates(this.buildingFootprint.fabricObject),
                canvasData: this._serializeUnit(this.buildingFootprint.fabricObject)
            } : null,
            levels: this.levels.map(l => ({
                id: l.id,
                name: l.name,
                ordinal: l.ordinal,
                short_name: l.short_name,
                floorplanImage: l.floorplanImage || null,
                footprint: l.footprint ? {
                    id: l.footprint.id,
                    coordinates: this.getObjectCoordinates(l.footprint.fabricObject),
                    canvasData: this._serializeUnit(l.footprint.fabricObject)
                } : null
            })),
            floorplanImage: null,
            createdAt: new Date().toISOString()
        };

        try {
            const response = await fetch('/api/projects/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: this.projectId,
                    projectName: projectName,
                    projectData: projectData
                })
            });

            const result = await response.json();
            
            if (result.success) {
                this.projectId = result.projectId;
                this.showToast('Project saved successfully!', 'success');
            } else {
                this.showToast('Save failed: ' + result.error, 'error');
            }
        } catch (error) {
            this.showToast('Save error: ' + error.message, 'error');
        }
    }

    async showLoadProjectModal() {
        try {
            const response = await fetch('/api/projects');
            const projects = await response.json();

            const list = document.getElementById('projectsList');
            list.innerHTML = '';

            if (projects.length === 0) {
                list.innerHTML = '<p>No saved projects found.</p>';
            } else {
                projects.forEach(project => {
                    const item = document.createElement('div');
                    item.className = 'project-item';
                    item.innerHTML = `
                        <h3>${project.name}</h3>
                        <p>Updated: ${new Date(project.updatedAt).toLocaleString()}</p>
                    `;
                    item.addEventListener('click', () => this.loadProject(project.id));
                    list.appendChild(item);
                });
            }

            document.getElementById('loadProjectModal').style.display = 'block';
        } catch (error) {
            this.showToast('Error loading projects: ' + error.message, 'error');
        }
    }

    async loadProject(projectId) {
        try {
            const response = await fetch(`/api/projects/${projectId}`);
            const project = await response.json();

            // Clear current state
            this.canvas.clear();
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.sections = [];
            this.buildingFootprint = null;
            this.currentLevel = null;

            // Load project data
            this.projectId = project.id;
            document.getElementById('projectName').value = project.name;
            
            const data = project.data;
            
            if (data.venue) {
                document.getElementById('venueCoords').value = data.venue.coordinates.join(', ');
            }
            
            if (data.building) {
                document.getElementById('buildingName').value = data.building.name;
            }

            // Load floor plan — legacy projects stored a single global image;
            // newer saves store floorplanImage per level (handled in selectLevel below).
            const legacyImage = data.floorplanImage || null;

            // Load levels (including their floorplanImage)
            if (data.levels) {
                this.levels = data.levels.map(l => ({
                    ...l,
                    // Fall back to the legacy global image for old saves
                    floorplanImage: l.floorplanImage || legacyImage || null
                }));
                this.renderLevelsList();
                if (this.levels.length > 0) {
                    this.selectLevel(this.levels[0]); // also loads the floor plan
                }
            } else if (legacyImage) {
                // No levels saved but there was a global floor plan — load it
                await this.loadFloorplanToCanvas(legacyImage);
            }

            // Load units
            if (data.units) {
                data.units.forEach(unitData => {
                    let fabricObj;
                    const cd = unitData.canvasData;
                    if (cd && cd.type === 'polygon' && cd.points) {
                        fabricObj = new fabric.Polygon(cd.points, {
                            left: cd.left,
                            top: cd.top,
                            scaleX: cd.scaleX || 1,
                            scaleY: cd.scaleY || 1,
                            angle: cd.angle || 0,
                            fill: 'rgba(0, 120, 212, 0.3)',
                            stroke: '#0078d4',
                            strokeWidth: 2,
                            selectable: true,
                            evented: true,
                            objectCaching: false
                        });
                    } else {
                        const left   = cd ? cd.left   : 100;
                        const top    = cd ? cd.top    : 100;
                        const width  = cd ? cd.width  : 100;
                        const height = cd ? cd.height : 100;
                        fabricObj = new fabric.Rect({
                            left, top, width, height,
                            scaleX: cd ? (cd.scaleX || 1) : 1,
                            scaleY: cd ? (cd.scaleY || 1) : 1,
                            angle: cd ? (cd.angle || 0) : 0,
                            fill: 'rgba(0, 120, 212, 0.3)',
                            stroke: '#0078d4',
                            strokeWidth: 2
                        });
                    }
                    unitData.fabricObject = fabricObj;
                    fabricObj.imdfData = unitData;
                    this.units.push(unitData);
                    this.canvas.add(fabricObj);
                });
            }

            // Load amenities
            if (data.amenities) {
                data.amenities.forEach(amenityData => {
                    const cd = amenityData.canvasData;
                    const circle = new fabric.Circle({
                        left:   cd ? cd.left   : 200,
                        top:    cd ? cd.top    : 200,
                        radius: cd ? cd.radius : 15,
                        fill: 'rgba(40, 167, 69, 0.5)',
                        stroke: '#28a745',
                        strokeWidth: 2
                    });
                    amenityData.fabricObject = circle;
                    circle.imdfData = amenityData;
                    this.amenities.push(amenityData);
                    this.canvas.add(circle);
                });
            }

            // Load fixtures
            if (data.fixtures) {
                data.fixtures.forEach(fixtureData => {
                    const cd = fixtureData.canvasData;
                    const line = new fabric.Line(
                        cd ? [cd.x1, cd.y1, cd.x2, cd.y2] : [100, 100, 150, 100],
                        { stroke: '#6c757d', strokeWidth: 3 }
                    );
                    fixtureData.fabricObject = line;
                    line.imdfData = fixtureData;
                    this.fixtures.push(fixtureData);
                    this.canvas.add(line);
                });
            }

            // Load openings
            if (data.openings) {
                data.openings.forEach(openingData => {
                    const cd = openingData.canvasData;
                    const line = new fabric.Line(
                        cd ? [cd.x1, cd.y1, cd.x2, cd.y2] : [100, 100, 130, 100],
                        { stroke: '#dc3545', strokeWidth: 4 }
                    );
                    openingData.fabricObject = line;
                    line.imdfData = openingData;
                    this.openings.push(openingData);
                    this.canvas.add(line);
                });
            }

            // Load sections
            if (data.sections) {
                data.sections.forEach(sectionData => {
                    const cd = sectionData.canvasData;
                    let fabricObj;
                    if (cd && cd.type === 'polygon' && cd.points) {
                        fabricObj = new fabric.Polygon(cd.points, {
                            left: cd.left, top: cd.top,
                            scaleX: cd.scaleX || 1, scaleY: cd.scaleY || 1, angle: cd.angle || 0,
                            fill: 'rgba(255, 165, 0, 0.2)', stroke: '#ff8c00',
                            strokeWidth: 2, strokeDashArray: [6, 3],
                            selectable: true, evented: true, objectCaching: false
                        });
                    } else {
                        fabricObj = new fabric.Rect({
                            left: cd ? cd.left : 100, top: cd ? cd.top : 100,
                            width: cd ? cd.width : 100, height: cd ? cd.height : 100,
                            fill: 'rgba(255, 165, 0, 0.2)', stroke: '#ff8c00', strokeWidth: 2
                        });
                    }
                    sectionData.fabricObject = fabricObj;
                    fabricObj.imdfData = sectionData;
                    this.sections.push(sectionData);
                    this.canvas.add(fabricObj);
                });
            }

            // Load building footprint
            if (data.buildingFootprint && data.buildingFootprint.canvasData) {
                const cd = data.buildingFootprint.canvasData;
                const poly = new fabric.Polygon(cd.points || [], {
                    left: cd.left, top: cd.top,
                    scaleX: cd.scaleX || 1, scaleY: cd.scaleY || 1, angle: cd.angle || 0,
                    fill: 'rgba(120, 80, 200, 0.1)', stroke: '#7850c8',
                    strokeWidth: 2, strokeDashArray: [8, 4],
                    selectable: true, evented: true, objectCaching: false
                });
                this.buildingFootprint = { id: data.buildingFootprint.id, type: 'building-footprint', fabricObject: poly };
                poly.imdfData = this.buildingFootprint;
                this.canvas.add(poly);
                this.canvas.sendToBack(poly);
            }

            // Restore level footprints onto level objects, then load canvas objects
            if (data.levels) {
                data.levels.forEach(savedLevel => {
                    const lvl = this.levels.find(l => l.id === savedLevel.id);
                    if (lvl && savedLevel.footprint && savedLevel.footprint.canvasData) {
                        const cd = savedLevel.footprint.canvasData;
                        const poly = new fabric.Polygon(cd.points || [], {
                            left: cd.left, top: cd.top,
                            scaleX: cd.scaleX || 1, scaleY: cd.scaleY || 1, angle: cd.angle || 0,
                            fill: 'rgba(0, 180, 120, 0.1)', stroke: '#00b478',
                            strokeWidth: 2, strokeDashArray: [8, 4],
                            selectable: true, evented: true, objectCaching: false
                        });
                        const fp = { id: savedLevel.footprint.id, type: 'level-footprint', levelId: lvl.id, fabricObject: poly };
                        poly.imdfData = fp;
                        lvl.footprint = fp;
                        this.canvas.add(poly);
                        this.canvas.sendToBack(poly);
                    }
                });
            }

            this.updateCounts();
            this.updateLevelVisibility();
            document.getElementById('loadProjectModal').style.display = 'none';
            this.showToast('Project loaded successfully!', 'success');
        } catch (error) {
            this.showToast('Error loading project: ' + error.message, 'error');
        }
    }

    newProject() {
        if (confirm('Start a new project? Any unsaved changes will be lost.')) {
            this.canvas.clear();
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.sections = [];
            this.buildingFootprint = null;
            this.currentLevel = null;
            this.projectId = null;
            this.canvas.backgroundImage = null;
            this.snapCanvas = null;
            this.snapCtx = null;
            
            document.getElementById('projectName').value = '';
            document.getElementById('buildingName').value = '';
            document.getElementById('venueCoords').value = '0, 0';
            
            this.renderLevelsList();
            this.updateCounts();
            this.clearSelection();
            this.showToast('New project started', 'info');
        }
    }

    async exportIMDF() {
        const projectName = document.getElementById('projectName').value || 'Untitled Project';
        
        const projectData = {
            venue: {
                id: this.generateUUID(),
                name: projectName,
                coordinates: this.parseCoordinates(document.getElementById('venueCoords').value)
            },
            building: {
                id: this.generateUUID(),
                name: document.getElementById('buildingName').value || 'Building',
                coordinates: this.getBuildingCoordinates()
            },
            levels: this.levels.map(l => ({
                id: l.id,
                name: l.name,
                ordinal: l.ordinal,
                short_name: l.short_name,
                coordinates: l.footprint
                    ? this.getObjectCoordinates(l.footprint.fabricObject)
                    : this.getLevelCoordinates()
            })),
            units: this.units.map(u => ({
                id: u.id,
                name: u.name,
                category: u.category,
                restriction: u.restriction,
                exchangeId: u.exchangeId || '',
                levelId: u.levelId,
                coordinates: this.getObjectCoordinates(u.fabricObject),
                display_point: this.getDisplayPoint(u.fabricObject)
            })),
            sections: this.sections.map(s => ({
                id: s.id,
                name: s.name,
                category: s.category,
                restriction: s.restriction,
                levelId: s.levelId,
                coordinates: this.getObjectCoordinates(s.fabricObject),
                display_point: this.getDisplayPoint(s.fabricObject)
            })),
            amenities: this.amenities.map(a => ({
                id: a.id,
                name: a.name,
                category: a.category,
                levelId: a.levelId,
                coordinates: this.getPointCoordinates(a.fabricObject)
            })),
            fixtures: this.fixtures.map(f => ({
                id: f.id,
                category: f.category,
                levelId: f.levelId,
                geometryType: 'LineString',
                coordinates: this.getLineCoordinates(f.fabricObject)
            })),
            openings: this.openings.map(o => ({
                id: o.id,
                category: o.category,
                levelId: o.levelId,
                coordinates: this.getLineCoordinates(o.fabricObject)
            })),
            anchors: []
        };

        try {
            const response = await fetch('/api/generate-imdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectData })
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'imdf-export.zip';
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                this.showToast('IMDF files exported successfully!', 'success');
            } else {
                this.showToast('Export failed', 'error');
            }
        } catch (error) {
            this.showToast('Export error: ' + error.message, 'error');
        }
    }

    // ── Polygon vertex editing ────────────────────────────────────

    showVertexHandles(polygon) {
        this.removeVertexHandles();

        // Disable the polygon's own transform controls while editing vertices
        polygon.set({
            hasControls: false,
            hasBorders: false,
            lockMovementX: true,
            lockMovementY: true
        });
        this.canvas.renderAll();

        const points = polygon.points;
        if (!points) return;

        // Convert each point from polygon-local space to canvas world space using
        // the full transform matrix (handles position, scale, rotation, skew).
        // pathOffset is the local-space origin Fabric centres the polygon on.
        const matrix = polygon.calcTransformMatrix();
        const ox = polygon.pathOffset ? polygon.pathOffset.x : 0;
        const oy = polygon.pathOffset ? polygon.pathOffset.y : 0;

        this.vertexHandles = points.map((pt, i) => {
            const world = fabric.util.transformPoint(
                new fabric.Point(pt.x - ox, pt.y - oy),
                matrix
            );
            const handle = new fabric.Circle({
                left:    world.x,
                top:     world.y,
                radius: 6,
                fill: '#ff5c00',
                stroke: '#ffffff',
                strokeWidth: 2,
                originX: 'center',
                originY: 'center',
                hasControls: false,
                hasBorders: false,
                selectable: true,
                evented: true,
                _vertexHandle: true,
                _polygon: polygon,
                _vertexIndex: i
            });
            this.canvas.add(handle);
            return handle;
        });

        this.canvas.renderAll();
    }

    removeVertexHandles() {
        if (!this.vertexHandles) return;
        this.vertexHandles.forEach(h => this.canvas.remove(h));
        this.vertexHandles = null;

        // Re-enable transform controls on the previously-edited polygon
        if (this.selectedObject && this.selectedObject.type === 'polygon') {
            this.selectedObject.set({
                hasControls: true,
                hasBorders: true,
                lockMovementX: false,
                lockMovementY: false
            });
            this.canvas.renderAll();
        }
    }

    updatePolygonVertex(handle) {
        const polygon = handle._polygon;
        const i = handle._vertexIndex;
        if (!polygon || i === undefined) return;

        // Snap to edge if enabled
        const raw = { x: handle.left, y: handle.top };
        const snapped = this.snapEnabled ? this.snapToEdge(raw) : raw;

        // Move handle to snapped position
        handle.set({ left: snapped.x, top: snapped.y });

        // Convert the world-space handle position back to polygon-local space.
        // invertTransform gives us the matrix that undoes position/scale/rotation.
        const matrix    = polygon.calcTransformMatrix();
        const invMatrix = fabric.util.invertTransform(matrix);
        const local     = fabric.util.transformPoint(
            new fabric.Point(snapped.x, snapped.y), invMatrix
        );

        // Points are stored relative to pathOffset in local space
        const ox = polygon.pathOffset ? polygon.pathOffset.x : 0;
        const oy = polygon.pathOffset ? polygon.pathOffset.y : 0;
        polygon.points[i] = { x: local.x + ox, y: local.y + oy };

        // Force Fabric to recompute the polygon geometry
        polygon.set({ dirty: true });
        this.canvas.renderAll();
    }

    // ── Toast notification helper ────────────────────────────────
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const icons = { success: '✓', error: '✕', info: 'ℹ' };
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
        container.appendChild(toast);

        const dismiss = () => {
            toast.classList.add('removing');
            toast.addEventListener('animationend', () => toast.remove(), { once: true });
        };
        setTimeout(dismiss, 4000);
        toast.addEventListener('click', dismiss);
    }

    // ── UUID generator ───────────────────────────────────────────
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // Returns true when the keyboard event originates from a text input / textarea
    // so we don't hijack Space while the user is typing in a property field.
    _isTyping(e) {
        const tag = e.target && e.target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    parseCoordinates(str) {
        const parts = str.split(',').map(s => parseFloat(s.trim()));
        return parts.length === 2 ? parts : [0, 0];
    }

    getBuildingCoordinates() {
        if (this.buildingFootprint && this.buildingFootprint.fabricObject) {
            return this.getObjectCoordinates(this.buildingFootprint.fabricObject);
        }
        return [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]];
    }

    getLevelCoordinates() {
        // Fallback when no level footprint is drawn — callers that have one use it directly
        return [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]];
    }

    _serializeUnit(obj) {
        if (!obj) return null;
        if (obj.type === 'polygon' && obj.points) {
            const ox = obj.pathOffset ? obj.pathOffset.x : 0;
            const oy = obj.pathOffset ? obj.pathOffset.y : 0;
            return {
                type: 'polygon',
                left: obj.left,
                top: obj.top,
                scaleX: obj.scaleX || 1,
                scaleY: obj.scaleY || 1,
                angle: obj.angle || 0,
                points: obj.points.map(p => ({ x: p.x, y: p.y })),
                pathOffsetX: ox,
                pathOffsetY: oy
            };
        }
        return {
            type: 'rect',
            left: obj.left,
            top: obj.top,
            width: obj.width,
            height: obj.height,
            scaleX: obj.scaleX || 1,
            scaleY: obj.scaleY || 1,
            angle: obj.angle || 0
        };
    }

    // ── Coordinate conversion helpers ────────────────────────────
    //
    // Canvas pixels use a top-left origin with Y increasing downward.
    // GeoJSON uses [longitude, latitude] where Y (latitude) increases upward.
    // We therefore negate Y on every export so the geometry is not vertically
    // flipped when loaded into QGIS or any other GIS tool.
    //
    // The 1/100000 scale factor converts pixel positions into a roughly
    // degree-scale coordinate space (placeholder until real georeferencing
    // is implemented).
    //
    // For polygons we apply the full Fabric transform matrix so that any
    // scale, rotation, or skew applied to the object via the bounding-box
    // handles is baked into the exported vertex positions.
    //
    // GeoJSON spec (and QGIS) require exterior rings to be counter-clockwise
    // (CCW). Negating Y to flip the coordinate system also reverses winding
    // order, so we explicitly enforce CCW on every exported ring.

    _canvasToGeo(canvasX, canvasY) {
        // Negate Y to flip from screen space (Y-down) to geo space (Y-up)
        return [canvasX / 100000, -canvasY / 100000];
    }

    // Compute the signed area of a closed ring using the shoelace formula.
    // Positive = CCW in standard math coords, negative = CW.
    _signedArea(ring) {
        let area = 0;
        const n = ring.length;
        for (let i = 0; i < n - 1; i++) {
            area += ring[i][0] * ring[i + 1][1];
            area -= ring[i + 1][0] * ring[i][1];
        }
        return area / 2;
    }

    // Ensure a ring (array of [x,y] pairs, first === last) is CCW.
    // GeoJSON exterior rings must be CCW; CW rings are treated as holes by QGIS.
    _ensureCCW(ring) {
        // Remove closing vertex for the area check, then re-close after reversing.
        const open = ring.slice(0, -1);
        if (this._signedArea(ring) < 0) {
            // CW — reverse to make CCW, then re-close
            open.reverse();
            return [...open, open[0]];
        }
        return ring;
    }

    // Return world-space vertices for a Fabric polygon, honouring all
    // transforms (left/top/scaleX/scaleY/angle/skew).
    _polygonWorldPoints(obj) {
        const matrix = obj.calcTransformMatrix();
        const ox = obj.pathOffset ? obj.pathOffset.x : 0;
        const oy = obj.pathOffset ? obj.pathOffset.y : 0;
        return obj.points.map(p => {
            // Points are stored relative to the polygon's pathOffset origin.
            // Translate to local origin, then apply the full object transform.
            const local = new fabric.Point(p.x - ox, p.y - oy);
            const world = fabric.util.transformPoint(local, matrix);
            return world;
        });
    }

    getObjectCoordinates(obj) {
        if (!obj) return [[[0, 0], [0, 0.0001], [0.0001, 0.0001], [0.0001, 0], [0, 0]]];

        // Fabric Polygon — apply full transform matrix so scale/rotation are baked in
        if (obj.type === 'polygon' && obj.points) {
            const worldPts = this._polygonWorldPoints(obj);
            const coords = worldPts.map(p => this._canvasToGeo(p.x, p.y));
            // Close the ring, then enforce CCW winding for GeoJSON compliance
            if (coords.length > 0) coords.push(coords[0]);
            return [this._ensureCCW(coords)];
        }

        // Fabric Rect (legacy rectangle units) — compute all four corners
        // by applying the full transform so rotation is respected.
        const matrix = obj.calcTransformMatrix();
        // IMPORTANT: calcTransformMatrix() already includes scaleX/scaleY, so the
        // local-space corners below must use the UNSCALED half-width/height.
        // Pre-multiplying by scaleX/scaleY here would double-apply the scale
        // (once here, once via the matrix), shrinking/misplacing every resized
        // rectangle unit on export relative to how it actually renders on canvas.
        const hw = obj.width  / 2;
        const hh = obj.height / 2;
        // Corners in local space (centred on origin because calcTransformMatrix
        // already includes the left/top translation)
        const corners = [
            { x: -hw, y: -hh },
            { x:  hw, y: -hh },
            { x:  hw, y:  hh },
            { x: -hw, y:  hh }
        ].map(c => {
            const w = fabric.util.transformPoint(new fabric.Point(c.x, c.y), matrix);
            return this._canvasToGeo(w.x, w.y);
        });
        corners.push(corners[0]); // close the ring
        return [this._ensureCCW(corners)];
    }

    getDisplayPoint(obj) {
        if (!obj) return { type: 'Point', coordinates: [0, 0] };

        // Use the object's actual centre in world space
        const center = obj.getCenterPoint
            ? obj.getCenterPoint()
            : { x: obj.left, y: obj.top };

        return {
            type: 'Point',
            coordinates: this._canvasToGeo(center.x, center.y)
        };
    }

    getPointCoordinates(obj) {
        if (!obj) return [0, 0];
        return this._canvasToGeo(obj.left, obj.top);
    }

    getLineCoordinates(obj) {
        if (!obj) return [[0, 0], [0, 0.0001]];
        // Lines store absolute canvas coords in x1/y1/x2/y2
        return [
            this._canvasToGeo(obj.x1, obj.y1),
            this._canvasToGeo(obj.x2, obj.y2)
        ];
    }

    updateCounts() {
        document.getElementById('levelCount').textContent = this.levels.length;
        document.getElementById('unitCount').textContent = this.units.length;
        document.getElementById('amenityCount').textContent = this.amenities.length;
        document.getElementById('fixtureCount').textContent = this.fixtures.length;
        document.getElementById('openingCount').textContent = this.openings.length;
        document.getElementById('sectionCount').textContent = this.sections.length;
    }

    updateCanvasInfo(text) {
        document.getElementById('canvasInfo').textContent = text;
    }
}

// Initialize the application
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new IMDFBuilder();
});
