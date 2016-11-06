/**
 * Network diagram.
 *
 * @constructor
 * @param {DOMElement} parent - the element to add this component to
 * @param {dict} args - A set of constructor arguments, including:
 * @param {int} args.id - the id of the server-side NetGraph to connect to
 *
 * NetGraph constructor is written into HTML file from the python
 * server and is run on page load.
 */

import * as interact from "interact.js";
import { dom, h, VNode } from "maquette";

import * as allComponents from "../components/all-components";
import { config } from "../config";
import * as menu from "../menu";
import * as viewport from "../viewport";
import { Connection } from "../websocket";
import { NetGraphConnection } from "./connection";
import { Minimap } from "./minimap";


import { NetGraphItem, NetGraphItemArg } from "./items/item.ts";
import { PassthroughItem } from "./items/interactable.ts";
import { EnsembleItem, NetItem, NodeItem} from "./items/resizable";

import "./netgraph.css";

interface ItemDict {
    [uid: string]: NetGraphItem;
}

interface ConnDict {
    [uid: string]: NetGraphConnection;
}

export class NetGraph {

    /**
     * Since connections may go to items that do not exist yet (since they
     * are inside a collapsed network), this dictionary keeps a list of
     * connections to be notified when a particular item appears.  The
     * key in the dictionary is the uid of the nonexistent item, and the
     * value is a list of NetGraphConnections that should be notified
     * when that item appears.
     */
    collapsedConns: ConnDict = {};
    root;
    div;
    gConns;
    gConnsMini;
    gItems;
    gItemsMini;
    gNetworks;
    gNetworksMini;
    height;
    inZoomDelay;
    menu;
    minimap;
    offsetX = 0; // Global x,y pan offset
    offsetY = 0; // Global x,y pan offset
    svg;
    svgConns: ConnDict = {};
    svgObjects: ItemDict = {};
    uid: string;
    view;
    width;
    parent;
    minimapObjects;

    private attached: Connection[] = [];

    private _scale: number = 1.0;

    constructor(uid: string) {
        this.uid = uid;

        // TODO: greatly improve this validation
        if (uid[0] === "<") {
            console.warn("invalid uid for NetGraph: " + uid);
        }

        this.inZoomDelay = false;

        // this.minimap = new Minimap();

        // Reading netgraph.css file as text and embedding it within def tags;
        // this is needed for saving the SVG plot to disk.
        // wtf... http://stackoverflow.com/q/13381503/1079075
        // TODO: Fix this
        const css = require("!!css-loader!./netgraph.css").toString();

        const defs = h("defs", [h(
            "style", {type: "text/css"}, ["<![CDATA[\n" + css + "\n]]>"]
        )]);

        // Three separate layers, so that expanded networks are at the back,
        // then connection lines, and then other items (nodes, ensembles, and
        // collapsed networks) are drawn on top.
        this.gNetworks = h("g");
        this.gConns = h("g");
        this.gItems = h("g");

        // Create the master SVG element
        this.svg = h("svg.netgraph#netgraph", {
            styles: {height: "100%", position: "absolute", width: "100%"},
            onresize: event => {
                this.onResize(event);
            },
        }, [
            defs,
            this.gNetworks,
            this.gConns,
            this.gItems,
        ]);

        // interact(this.svg).styleCursor(false);

        this.width = this.svg.getBoundingClientRect().width;
        this.height = this.svg.getBoundingClientRect().height;

        // Respond to resize events
        window.addEventListener("resize", event => {
            this.onResize(event);
        });

        // Dragging the background pans the full area by changing offsetX,Y
        // Define cursor behaviour for background
        interact(this.svg)
            .on("mousedown", () => {
                const cursor = document.documentElement.getAttribute("style");
                if (cursor !== null) {
                    if (cursor.match(/resize/) == null) {
                        // Don't change resize cursor
                        document.documentElement.setAttribute(
                            "style", "cursor:move;");
                    }
                }
            })
            .on("mouseup", () => {
                document.documentElement
                    .setAttribute("style", "cursor:default;");
            });

        interact(this.svg)
            .draggable({
                onend: event => {
                    // Let the server know what happened
                    this.attached.forEach(conn => {
                        conn.send("netgraph.pan",
                            {x: this.offsetX, y: this.offsetY});
                    });
                },
                onmove: event => {
                    this.offsetX += event.dx / this.getScaledWidth();
                    this.offsetY += event.dy / this.getScaledHeight();
                    Object.keys(this.svgObjects).forEach(key => {
                        this.svgObjects[key].redrawPosition();
                        // if (this.mmDisplay) {
                        //     this.minimapObjects[key].redrawPosition();
                        // }
                    });
                    Object.keys(this.svgConns).forEach(key => {
                        this.svgConns[key].redraw();
                    });

                    viewport.setPosition(this.offsetX, this.offsetY);

                    this.scaleMiniMapViewBox();

                },
                onstart: () => {
                    menu.hideAny();
                },
            });

        // Scrollwheel on background zooms the full area by changing scale.
        // Note that offsetX,Y are also changed to zoom into a particular
        // point in the space
        interact(document.getElementById("main"))
            .on("click", event => {
                document.querySelector(".aceText-input")
                    .dispatchEvent(new Event("blur"));
            })
            .on("wheel", event => {
                event.preventDefault();

                menu.hideAny();
                const x = (event.clientX) / this.width;
                const y = (event.clientY) / this.height;
                let delta;

                if (event.deltaMode === 1) {
                    // DOMDELTALINE
                    if (event.deltaY !== 0) {
                        delta = Math.log(1. + Math.abs(event.deltaY)) * 60;
                        if (event.deltaY < 0) {
                            delta *= -1;
                        }
                    } else {
                        delta = 0;
                    }
                } else if (event.deltaMode === 2) {
                    // DOMDELTAPAGE
                    // No idea what device would generate scrolling by a page
                    delta = 0;
                } else {
                    // DOMDELTAPIXEL
                    delta = event.deltaY;
                }

                let zScale = 1. + Math.abs(delta) / 600.;
                if (delta > 0) {
                    zScale = 1. / zScale;
                }

                allComponents.saveLayouts();

                const xx = x / this.scale - this.offsetX;
                const yy = y / this.scale - this.offsetY;
                this.offsetX = (this.offsetX + xx) / zScale - xx;
                this.offsetY = (this.offsetY + yy) / zScale - yy;

                this.scale = zScale * this.scale;
                viewport.setPosition(this.offsetX, this.offsetY);

                this.scaleMiniMapViewBox();

                this.redraw();

                // Let the server know what happened
                this.attached.forEach(conn => {
                    conn.send("netgraph.zoom",
                        {scale: this.scale, x: this.offsetX, y: this.offsetY});
                });
            });

        this.menu = new menu.Menu(this.parent);

        // Determine when to pull up the menu
        interact(this.svg)
            .on("hold", event => { // Change to "tap" for right click
                if (event.button === 0) {
                    if (this.menu.visibleAny()) {
                        menu.hideAny();
                    } else {
                        this.menu.show(event.clientX, event.clientY,
                                       this.generateMenu());
                    }
                    event.stopPropagation();
                }
            })
            .on("tap", event => { // Get rid of menus when clicking off
                if (event.button === 0) {
                    if (this.menu.visibleAny()) {
                        menu.hideAny();
                    }
                }
            });

        this.svg.addEventListener("contextmenu", event => {
            event.preventDefault();
            if (this.menu.visibleAny()) {
                menu.hideAny();
            } else {
                this.menu.show(
                    event.clientX, event.clientY, this.generateMenu());
            }
        });

        this.createMinimap();
        this.updateFonts();
    }

    get aspectResize(): boolean {
        return config.aspectResize;
    }

    set aspectResize(val) {
        if (val === this.aspectResize) {
            return;
        }
        config.aspectResize = val;
    }

    get fontSize(): number {
        return config.fontSize;
    }

    set fontSize(val: number) {
        if (val === this.fontSize) {
            return;
        }
        config.fontSize = val;
        this.updateFonts();
    }

    get scale(): number {
        return this._scale;
    }

    set scale(val: number) {
        if (val === this._scale) {
            return;
        }
        this._scale = val;
        this.updateFonts();
        this.redraw();

        viewport.setScale(this._scale);
    }

    get transparentNets(): boolean {
        return config.transparentNets;
    }

    set transparentNets(val: boolean) {
        if (val === config.transparentNets) {
            return;
        }
        config.transparentNets = val;
        Object.keys(this.svgObjects).forEach(key => {
            const ngi = this.svgObjects[key];
            ngi.computeFill();
            if (ngi.type === "net" && ngi.expanded) {
                ngi.shape.style["fill-opacity"] = val ? 0.0 : 1.0;
            }
        });
    }

    get zoomFonts(): boolean {
        return config.zoomFonts;
    }

    set zoomFonts(val: boolean) {
        if (val === config.zoomFonts) {
            return;
        }
        config.zoomFonts = val;
        this.updateFonts();
    }

    generateMenu() {
        return [["Auto-layout", () => {
            this.attached.forEach(conn => {
                conn.send("netgraph.feedforwardLayout");
            });
        }]];
    }

    /**
     * Event handler for received WebSocket messages
     */
    attach(conn: Connection) {
        // TODO: Am I supposed to group these more logically?

        // TODO: How do I associate types to this whole bind thing?
        // TODO: How do I make sure this is calling the correct constructor?
        // Node-only first so that I can get something I can test
        conn.bind("netGraph.createNode", ({ngiArg: NetGraphItemArg}) => {
            this.createNode(ngiArg);
        });

        conn.bind("netGraph.createConnection", ({connArg}) => {
            this.createConnection(connArg);
        });

        // there should probably be a coordinate data type
        conn.bind("netGraph.pan", ({x: Number, y: Number}) => {
            this.setOffset(x, y);
        });

        conn.bind("netGraph.zoom", ({zoom: Number}) => {
            this.scale = zoom;
        });

        // TODO: How much error checking are we supposed to do?
        // Should I check that the uid gives a network or do I just
        // let it throw an error?
        conn.bind("netGraph.expand", ({uid: String}) => {
            item = this.svgObjects[uid];
            item.expand(true, true);
        });
        conn.bind("netGraph.collapse", ({uid: String}) => {
            item = this.svgObjects[uid];
            item.expand(true, true);
        });

        // Should probably make a shape param too
        conn.bind("netGraph.posSize", ({uid: String, x: Number, y: Number, width: Number, height: Number}) => {
            item = this.svgObjects[data.uid];
            item.x = x;
            item.y = y;
            item.width = width;
            item.height = height;

            item.redraw();

            this.scaleMiniMap();
        });

        conn.bind("netGraph.config", ({uid: String, config}) => {
            // Anything about the config of a component has changed
            const component = allComponents.byUID(uid);
            component.updateLayout(config);
        });

        conn.bind("netGraph.config", ({uid: String, config}) => {
            // Anything about the config of a component has changed
            const component = allComponents.byUID(uid);
            component.updateLayout(config);
        });

        conn.bind("netGraph.js", ({js: js}) => {
            // TODO: noooooooo
            eval(js);
        });

        conn.bind("netGraph.rename", ({uid: String, newName: String}) => {
            item = this.svgObjects[uid];
            item.setLabel(newName);
        });

        conn.bind("netGraph.remove", ({uid: String}) => {
            // TODO: this feels hacky
            item = this.svgObjects[uid];
            if (item === undefined) {
                item = this.svgConns[uid];
            }

            item.remove();
        });

        conn.bind("netGraph.reconnect", ({uid: String, pres: NetGraphItem, post: NetGraphItem}) => {
            const conn = this.svgConns[uid];
            conn.setPres(pres);
            conn.setPosts(posts);
            conn.setRecurrent(pres[0] === posts[0]);
            conn.redraw();
        });

        conn.bind("netGraph.reconnect", ({uid: String, notifyServer: Boolean}) => {
            const component = allComponents.byUID(uid);
            component.remove(true, notifyServer);
        });

        this.attached.push(conn);
    }

    /**
     * Pan the screen (and redraw accordingly)
     */
    setOffset(x, y) {
        this.offsetX = x;
        this.offsetY = y;
        this.redraw();

        viewport.setPosition(x, y);
    }

    updateFonts() {
        if (this.zoomFonts) {
            document.getElementById("main").style.fontSize =
                           3 * this.scale * this.fontSize / 100 + "em";
        } else {
            document.getElementById("#main").style.fontSize =
                this.fontSize / 100 + "em";
        }
    }

    /**
     * Redraw all elements
     */
    redraw() {
        Object.keys(this.svgObjects).forEach(key => {
            this.svgObjects[key].redraw();
        });
        Object.keys(this.svgConns).forEach(key => {
            this.svgConns[key].redraw();
        });
    }

    /**
     * Create a new NetGraphItem.
     *
     * If an existing NetGraphConnection is looking for this item, it will be
     * notified
     */
    createObject(info) {
        // TODO: this should be actual arguments, not just an arbitrary object
        const itemMini = new NetGraphItem(this, info, true, null);
        this.minimapObjects[info.uid] = itemMini;

        const item = new NetGraphItem(this, info, false, itemMini);
        this.svgObjects[info.uid] = item;

        this.detectCollapsedConns(item.uid);
        this.detectCollapsedConns(itemMini.uid);

        this.scaleMiniMap();
    }

    // this will need to be refactored later
    createNode(ngiArg) {
        // TODO: fill in the rest of the args
        const item = new NodeItem(ngiArg);
        this.svgObjects[info.uid] = item;

        this.detectCollapsedConns(item.uid);
    }

    /**
     * Create a new NetGraphConnection.
     */
    createConnection(info) {
        const connMini = new NetGraphConnection(this, info, true, null);
        this.svgConns[info.uid] = new NetGraphConnection(
            this, info, false, connMini);
    }

    /**
     * Handler for resizing the full SVG.
     */
    onResize(event) {
        const width = this.svg.getBoundingClientRect().width;
        const height = this.svg.getBoundingClientRect().height;

        if (this.aspectResize) {
            Object.keys(this.svgObjects).forEach(key => {
                const item = this.svgObjects[key];
                if (item.depth === 1) {
                    const newWidth =
                        viewport.scaleWidth(item.width) / this.scale;
                    const newHeight =
                        viewport.scaleHeight(item.height) / this.scale;
                    item.width = newWidth / (2 * width);
                    item.height = newHeight / (2 * height);
                }
            });
        }

        this.width = width;
        this.height = height;
        // this.mmWidth = $(this.minimap).width();
        // this.mmHeight = $(this.minimap).height();

        this.redraw();
    }

    /**
     * Return the pixel width of the SVG times the current scale factor.
     */
    getScaledWidth() {
        return this.width * this.scale;
    }

    /**
     * Return the pixel height of the SVG times the current scale factor.
     */
    getScaledHeight() {
        return this.height * this.scale;
    }

    /**
     * Expand or collapse a network.
     */
    toggleNetwork(uid) {
        const item = this.svgObjects[uid];
        if (item.expanded) {
            item.collapse(true);
        } else {
            item.expand();
        }
    }

    /**
     * Register a NetGraphConnection with a target item that it is looking for.
     *
     * This is a NetGraphItem that does not exist yet, because it is inside a
     * collapsed network. When it does appear, NetGraph.detectCollapsed will
     * handle notifying the NetGraphConnection.
     */
    registerConn(conn, target) {
        // if (this.collapsedConns[target] === undefined) {
        //     this.collapsedConns[target] = [conn];
        // } else {
        //     const index = this.collapsedConns[target].indexOf(conn);
        //     if (index === -1) {
        //         this.collapsedConns[target].push(conn);
        //     }
        // }
    }

    /**
     * Manage collapsedConns dictionary.
     *
     * If a NetGraphConnection is looking for an item with a particular uid,
     * but that item does not exist yet (due to it being inside a collapsed
     * network), then it is added to the collapsedConns dictionary. When
     * an item is created, this function is used to see if any
     * NetGraphConnections are waiting for it, and notifies them.
     */
    detectCollapsedConns(uid) {
        // const conns = this.collapsedConns[uid];
        // if (conns !== undefined) {
        //     delete this.collapsedConns[uid];
        //     for (let i = 0; i < conns.length; i++) {
        //         const conn = conns[i];
        //         // Make sure the NetGraphConnection hasn't been removed since
        //         // it started listening.
        //         if (!conn.removed) {
        //             conn.setPre(conn.findPre());
        //             conn.setPost(conn.findPost());
        //             conn.redraw();
        //         }
        //     }
        // }
    }

    /**
     * Create a minimap.
     */
    createMinimap() {
        // this.minimapDiv = document.createElement("div");
        // this.minimapDiv.className = "minimap";
        // this.parent.appendChild(this.minimapDiv);

        // this.minimap = h("svg");
        // this.minimap.classList.add("minimap");
        // this.minimap.id = "minimap";
        // this.minimapDiv.appendChild(this.minimap);

        // Box to show current view
        // this.view = h("rect");
        // this.view.classList.add("view");
        // this.minimap.appendChild(this.view);

        this.gNetworksMini = h("g");
        this.gConnsMini = h("g");
        this.gItemsMini = h("g");
        // Order these are appended is important for layering
        this.minimap.appendChild(this.gNetworksMini);
        this.minimap.appendChild(this.gConnsMini);
        this.minimap.appendChild(this.gItemsMini);

        // this.mmWidth = $(this.minimap).width();
        // this.mmHeight = $(this.minimap).height();

        // Default display minimap
        // this.mmDisplay = true;
        this.toggleMiniMap();
    }

    toggleMiniMap() {
        // if (this.mmDisplay === true) {
        //     $(".minimap")[0].style.visibility = "hidden";
        //     this.gConnsMini.style.opacity = 0;
        //     this.mmDisplay = false;
        // } else {
        //     $(".minimap")[0].style.visibility = "visible";
        //     this.gConnsMini.style.opacity = 1;
        //     this.mmDisplay = true ;
        //     this.scaleMiniMap();
        // }
    }

    /**
     * Calculate the minimap position offsets and scaling.
     */
    scaleMiniMap() {
        // if (!this.mmDisplay) {
        //     return;
        // }

        // const keys = Object.keys(this.svgObjects);
        // if (keys.length === 0) {
        //     return;
        // }

        // // TODO: Could also store the items at the four min max values
        // // and only compare against those, or check against all items
        // // in the lists when they move. Might be important for larger
        // // networks.
        // let firstItem = true;
        // Object.keys(this.svgObjects).forEach(key => {
        //     const item = this.svgObjects[key];
        //     // Ignore anything inside a subnetwork
        //     if (item.depth > 1) {
        //         return;
        //     }

        //     const minmaxXy = item.getMinMaxXY();
        //     if (firstItem === true) {
        //         this.mmMinX = minmaxXy[0];
        //         this.mmMaxX = minmaxXy[1];
        //         this.mmMinY = minmaxXy[2];
        //         this.mmMaxY = minmaxXy[3];
        //         firstItem = false;
        //         return;
        //     }

        //     if (this.mmMinX > minmaxXy[0]) {
        //         this.mmMinX = minmaxXy[0];
        //     }
        //     if (this.mmMaxX < minmaxXy[1]) {
        //         this.mmMaxX = minmaxXy[1];
        //     }
        //     if (this.mmMinY > minmaxXy[2]) {
        //         this.mmMinY = minmaxXy[2];
        //     }
        //     if (this.mmMaxY < minmaxXy[3]) {
        //         this.mmMaxY = minmaxXy[3];
        //     }
        // });

        // this.mmScale = 1 / Math.max(this.mmMaxX - this.mmMinX,
        //                              this.mmMaxY - this.mmMinY);

        // // Give a bit of a border
        // this.mmMinX -= this.mmScale * .05;
        // this.mmMaxX += this.mmScale * .05;
        // this.mmMinY -= this.mmScale * .05;
        // this.mmMaxY += this.mmScale * .05;
        // // TODO: there is a better way to do this than recalculate
        // this.mmScale = 1 / Math.max(this.mmMaxX - this.mmMinX,
        //                              this.mmMaxY - this.mmMinY);

        // this.redraw();
        // this.scaleMiniMapViewBox();
    }

    /**
     * Scale the viewbox in the minimap.
     *
     * Calculate which part of the map is being displayed on the
     * main viewport and scale the viewbox to reflect that.
     */
    scaleMiniMapViewBox() {
        // if (!this.mmDisplay) {
        //     return;
        // }

        // const mmW = this.mmWidth;
        // const mmH = this.mmHeight;

        // const w = mmW * this.mmScale;
        // const h = mmH * this.mmScale;

        // const dispW = (this.mmMaxX - this.mmMinX) * w;
        // const dispH = (this.mmMaxY - this.mmMinY) * h;

        // const viewOffsetX = -(this.mmMinX + this.offsetX) *
        //     w + (mmW - dispW) / 2.;
        // const viewOffsetY = -(this.mmMinY + this.offsetY) *
        //     h + (mmH - dispH) / 2.;

        // this.view.setAttributeNS(null, "x", viewOffsetX);
        // this.view.setAttributeNS(null, "y", viewOffsetY);
        // this.view.setAttribute("width", w / this.scale);
        // this.view.setAttribute("height", h / this.scale);
    }
}
