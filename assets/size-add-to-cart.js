/*
  size-add-to-cart.js - FINAL OPTIMIZED VERSION with MEMORY LEAK PREVENTION & EXPONENTIAL BACKOFF
  - Implements optimistic UI updates for instant perceived performance.
  - Runs network operations (add to cart, fetch cart JSON, fetch fragment) in parallel.
  - Fixes all scoping and duplicate function issues.
  - Includes enhanced inventory validation with low-stock warnings.
  - FIX: Re-opens cart drawer after content injection to solve the "blank offcanvas" issue.
  - ADDITION: Implements comprehensive memory leak prevention and cleanup functions.
  - ADDITION: Implements Exponential Backoff for network resilience.
*/
(function (global) {
  "use strict";

  // **MEMORY LEAK PREVENTION: Store listener references for later removal**
  var boundEventListeners = {
    sizeButtonClick: null,
    sizeButtonKeydown: null,
    sizeButtonMouseenter: null,
    documentClick: null,
    documentKeydown: null,
    documentOverlayClick: null,
    mutationObserver: null,
  };
  var mutationObserverInstance = null;
  var attachedButtonSet = new Set(); // Track buttons to prevent duplicate attachments

  // **OPTIMIZATION 7: Cache last known cart state**
  var cachedCart = null;
  var config = {
    sizeButtonSelector: ".size-btn, .variant-swatch, [data-variant-id]",
    sizeLabelSelector: ".size-label-text",
    dataVariantAttr: "variantId",
    dataAvailableAttr: "available",
    inFlightAttr: "inflight",
    loadingClass: "is-loading",
    disabledSelector: '[aria-disabled="true"], [disabled] ',
    productJsonSelector:
      'script[type="application/json"][data-product-json], script[data-product-json]',
    productJsonIdPrefix: "ProductJson-",
    cartAddUrl: "/cart/add.js",
    cartJsonUrl: "/cart.js",
    cartCountSelector: ".cart-count",
    hiddenVariantInputSelector: 'input[name="id"]',
    ariaLiveSelector: "#size-add-to-cart-live",
    toastContainerSelector: "#global-toasts",
    cartDrawerOpenFunction: "openCartDrawer",
    requestTimeoutMs: 8000,
    retryDelayMs: 600, // Base delay for exponential backoff
    maxRetries: 2, // Increased default retries
  };

  // --- Utility Functions ---
  function $(selector, context) {
    return (context || document).querySelector(selector);
  }
  function $all(selector, context) {
    return Array.prototype.slice.call(
      (context || document).querySelectorAll(selector)
    );
  }

  function parseProductJson() {
    var el = $(config.productJsonSelector);
    if (el) {
      try {
        return JSON.parse(el.textContent);
      } catch (e) {
        return null;
      }
    }
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.id && s.id.indexOf(config.productJsonIdPrefix) === 0) {
        try {
          return JSON.parse(s.textContent);
        } catch (e) {}
      }
    }
    return null;
  }

  // Map to track in-flight adds per variant to prevent duplicate adds (race conditions)
  var pendingVariants = {};

  function clearInFlightState(btn, variantId) {
    try {
      if (btn) {
        try {
          btn.dataset[config.inFlightAttr] = "0";
        } catch (e) {}
        try {
          btn.classList.remove(config.loadingClass);
        } catch (e) {}
        try {
          btn.removeAttribute && btn.removeAttribute("aria-busy");
        } catch (e) {}
        try {
          btn._sizeAddProcessing = false;
        } catch (e) {}
      }
      if (variantId) {
        try {
          delete pendingVariants[variantId];
        } catch (e) {}
      }
    } catch (e) {}
  }

  function normalizeSize(str) {
    if (!str) return "";
    return str
      .toString()
      .toLowerCase()
      .replace(/[_\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findVariantFromProductJson(productJson, optionIndex, sizeValue) {
    if (!productJson || !productJson.variants) return null;
    var norm = normalizeSize(sizeValue);
    for (var i = 0; i < productJson.variants.length; i++) {
      var v = productJson.variants[i];
      var opt = (v.options && v.options[optionIndex]) || v.option1 || "";
      if (normalizeSize(opt) === norm) return v;
    }
    for (i = 0; i < productJson.variants.length; i++) {
      v = productJson.variants[i];
      var found = false;
      for (var j = 0; j < (v.options || []).length; j++) {
        if (normalizeSize((v.options || [])[j]).indexOf(norm) !== -1) {
          found = true;
          break;
        }
      }
      if (found) return v;
    }
    return null;
  }

  // REPLACED validateInventory function with improved logic
  function validateInventory(productJson, variantId) {
    try {
      // If no product JSON available, return null (unknown - let server validate)
      if (!productJson || !productJson.variants) {
        return {
          available: null,
          reason: "unknown",
          message: null,
          lowStock: false,
        };
      }
      // Find the variant in product JSON
      var variant = null;
      for (var i = 0; i < productJson.variants.length; i++) {
        var v = productJson.variants[i];
        if (!v) continue;
        if (
          String(v.id) === String(variantId) ||
          String(v.variant_id) === String(variantId)
        ) {
          variant = v;
          break;
        }
      }
      // Variant not found in product data
      if (!variant) {
        return {
          available: false,
          reason: "variant_not_found",
          message: "This size is not available.",
          lowStock: false,
        };
      }
      // Check 1: Shopify's `available` flag (most reliable)
      if (typeof variant.available !== "undefined") {
        if (!variant.available) {
          return {
            available: false,
            reason: "out_of_stock",
            message: "This size is currently out of stock.",
            lowStock: false,
          };
        }
      }
      // Check 2: Inventory management and policy
      if (variant.inventory_management) {
        // If inventory tracking is enabled
        if (typeof variant.inventory_quantity !== "undefined") {
          var qty = variant.inventory_quantity;
          // Check inventory policy - respect Shopify's deny/continue setting
          if (variant.inventory_policy === "deny" && qty <= 0) {
            return {
              available: false,
              reason: "out_of_stock",
              message: "This size is currently out of stock.",
              lowStock: false,
            };
          }
          // Check for low stock (1-3 items remaining) - creates urgency
          if (qty > 0 && qty <= 3) {
            return {
              available: true,
              reason: "low_stock",
              message: "Only " + qty + " left in stock!",
              lowStock: true,
              quantity: qty,
            };
          }
          // Check if completely out of stock
          if (qty <= 0) {
            return {
              available: false,
              reason: "out_of_stock",
              message: "This size is currently out of stock.",
              lowStock: false,
            };
          }
        }
      }
      // All checks passed - item is available
      return {
        available: true,
        reason: "in_stock",
        message: null,
        lowStock: false,
      };
    } catch (e) {
      try {
        console.error && console.error("validateInventory error", e);
      } catch (er) {}
      // On error, return null to allow add (server will validate)
      return {
        available: null,
        reason: "error",
        message: null,
        lowStock: false,
      };
    }
  }

  function createAriaLive() {
    var live = $(config.ariaLiveSelector);
    if (live) return live;
    live = document.createElement("div");
    live.id = config.ariaLiveSelector.replace("#", "");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    live.style.position = "absolute";
    live.style.left = "-9999px";
    live.style.width = "1px";
    live.style.height = "1px";
    document.body.appendChild(live);
    return live;
  }

  // ADDED MISSING announceToScreenReader function (now correctly placed)
  function announceToScreenReader(message) {
    try {
      var live = createAriaLive();
      if (!live) return;
      // Clear first for reliable announcement - ensures screen readers detect the change
      live.textContent = "";
      setTimeout(function () {
        live.textContent = message;
      }, 100);
    } catch (e) {
      try {
        console.error && console.error("announceToScreenReader error", e);
      } catch (er) {}
    }
  }

  // MOVED updateSizeButtonSelection inside the IIFE and updated scoping
  /**
   * Marks a size button as selected and deselects all others in the same container.
   * This provides visual feedback showing which size is currently chosen.
   * @param {HTMLElement} selectedButton - The button that was clicked
   */
  function updateSizeButtonSelection(selectedButton) {
    try {
      if (!selectedButton) return;
      // Find the container holding all size buttons for this product
      var container = selectedButton.closest(
        ".size-buttons-grid, .card-size-swatches, .size-selector-container"
      );
      if (!container) {
        // Fallback: look for parent form or product section
        container = selectedButton.closest(
          "form, [data-product-form], .product, .card"
        );
      }
      if (!container) {
        // Last resort: look for closest product wrapper
        container =
          selectedButton.closest('[class*="product"]') ||
          selectedButton.closest('[id*="product"]') ||
          selectedButton.closest('[id*="Product"]');
      }
      if (!container) {
        // If still no container, only deselect siblings
        var parent = selectedButton.parentElement;
        if (parent) {
          container = parent;
        } else {
          // Absolute fallback - just select this button
          try {
            selectedButton.setAttribute("aria-pressed", "true");
            selectedButton.setAttribute("data-selected", "true");
            selectedButton.classList.add("is-selected");
          } catch (e) {}
          return;
        }
      }
      // Get all size buttons in this SPECIFIC container only
      var allButtons = container.querySelectorAll(config.sizeButtonSelector);

      // Deselect all buttons in this container first
      for (var i = 0; i < allButtons.length; i++) {
        var btn = allButtons[i];
        try {
          btn.setAttribute("aria-pressed", "false");
          btn.removeAttribute("data-selected");
          btn.classList.remove("is-selected");
          // Update aria-label for screen readers
          var label = btn.getAttribute("aria-label") || btn.textContent || "";
          if (label) {
            label = label.replace(/,?\s*selected$/i, "").trim();
            if (btn.hasAttribute("aria-label")) {
              btn.setAttribute("aria-label", label);
            }
          }
        } catch (e) {}
      }

      // Mark the clicked button as selected
      try {
        selectedButton.setAttribute("aria-pressed", "true");
        selectedButton.setAttribute("data-selected", "true");
        selectedButton.classList.add("is-selected");
        // Update aria-label for screen readers
        var selectedLabel =
          selectedButton.getAttribute("aria-label") ||
          selectedButton.textContent ||
          "";
        if (selectedLabel && !selectedLabel.match(/selected$/i)) {
          selectedButton.setAttribute(
            "aria-label",
            selectedLabel.trim() + ", selected"
          );
        }
        // Announce selection to screen readers
        // This is skipped here and handled later in the main click function to work better with the optimistic flow
      } catch (e) {
        try {
          console.error && console.error("Error setting selected state", e);
        } catch (er) {}
      }
    } catch (e) {
      try {
        console.error && console.error("updateSizeButtonSelection error", e);
      } catch (er) {}
    }
  }

  // MOVED initializeSizeButtonStates to the top level of the IIFE
  /**
   * Initialize the selection state for size buttons on page load.
   * If a size is pre-selected (e.g., from URL parameter or default), mark it as selected.
   */
  function initializeSizeButtonStates() {
    try {
      // Find all size button containers
      var containers = document.querySelectorAll(
        ".size-buttons-grid, .card-size-swatches, .size-selector-container"
      );
      for (var i = 0; i < containers.length; i++) {
        var container = containers[i];
        // Check if any button is already marked as selected in HTML
        var preSelected = container.querySelector(
          '.size-btn[aria-pressed="true"], .size-btn[data-selected="true"], .size-btn.is-selected, ' +
            '.variant-swatch[aria-pressed="true"], .variant-swatch[data-selected="true"], .variant-swatch.is-selected'
        );
        if (preSelected) {
          updateSizeButtonSelection(preSelected);
        } else {
          // Check if there's a hidden input with a selected variant
          var form = container.closest("form, [data-product-form]");
          if (form) {
            var hiddenInput = form.querySelector('input[name="id"]');
            if (hiddenInput && hiddenInput.value) {
              // Find button matching this variant ID
              var matchingBtn = container.querySelector(
                config.sizeButtonSelector +
                  '[data-variant-id="' +
                  hiddenInput.value +
                  '"]'
              );
              if (matchingBtn) {
                updateSizeButtonSelection(matchingBtn);
              }
            }
          }
        }
      }
    } catch (e) {
      try {
        console.error && console.error("initializeSizeButtonStates error", e);
      } catch (er) {}
    }
  }

  function createToastContainer() {
    var c = $(config.toastContainerSelector);
    if (c) return c;
    c = document.createElement("div");
    c.id = config.toastContainerSelector.replace("#", "");
    c.style.position = "fixed";
    c.style.right = "1rem";
    c.style.top = "1rem";
    c.style.zIndex = "9999";
    document.body.appendChild(c);
    return c;
  }

  function showToast(message, type) {
    var c = createToastContainer();
    var toast = document.createElement("div");
    toast.className = "size-add-toast " + (type || "info");
    toast.textContent = message;
    toast.style.background = type === "error" ? "#fee2e2" : "#111827";
    toast.style.color = type === "error" ? "#991b1b" : "#fff";
    toast.style.padding = "8px 12px";
    toast.style.marginTop = "8px";
    toast.style.borderRadius = "6px";
    c.appendChild(toast);
    setTimeout(function () {
      toast.remove();
    }, 4000);
  }

  function fetchWithTimeout(url, opts, timeoutMs) {
    timeoutMs = timeoutMs || config.requestTimeoutMs;
    var controller = new AbortController();
    var id = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    opts = opts || {};
    opts.signal = controller.signal;
    return fetch(url, opts).finally(function () {
      clearTimeout(id);
      // AbortController cleanup is handled by fetch when signal is aborted.
      // Explicitly nullifying the controller here isn't strictly necessary
      // but can be done for clarity if desired.
      // controller = null; // Optional
    });
  }

  function postAddToCart(variantId) {
    var body = "id=" + encodeURIComponent(variantId) + "&quantity=1";
    return fetchWithTimeout(
      config.cartAddUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: body,
      },
      config.requestTimeoutMs
    ).then(function (res) {
      if (!res.ok) throw new Error("Network response not ok");
      return res.json();
    });
  }

  function fetchCartJson() {
    return fetchWithTimeout(config.cartJsonUrl, { method: "GET" }, 5000)
      .then(function (res) {
        if (!res.ok) throw new Error("Cart fetch failed");
        return res.json();
      })
      .then(function (cart) {
        cachedCart = cart; // Cache for optimistic updates
        return cart;
      });
  }

  function renderCartDrawerFromJson(cart) {
    try {
      if (!cart) return;
      var container =
        document.getElementById("CartDrawer-CartItems") ||
        document.getElementById("CartDrawer-Form") ||
        document.getElementById("CartDrawer");
      if (!container) {
        return;
      }
      var wrapper = document.createElement("div");
      wrapper.className = "drawer__cart-items-wrapper";
      if (!cart.items || cart.items.length === 0) {
        wrapper.innerHTML =
          '<div class="drawer__empty"><p class="cart__empty-text">Your cart is empty.</p></div>';
        container.innerHTML = "";
        container.appendChild(wrapper);
        return;
      }
      var ul = document.createElement("ul");
      ul.className = "cart-items list-unstyled";
      cart.items.forEach(function (item, idx) {
        var li = document.createElement("li");
        li.id = "CartDrawer-Item-" + (idx + 1);
        li.className =
          "cart-drawer-item cart-item cart-item--product-" +
          (item.handle || "");
        li.setAttribute("role", "row");
        li.setAttribute("data-index", String(idx + 1));
        li.setAttribute("data-quantity", String(item.quantity || 0));
        var media = "";
        if (item.image) {
          media =
            '<div class="cart-item__media" role="cell">' +
            (item.url
              ? '<a href="' +
                (item.url || "#") +
                '" class="cart-item__link" tabindex="-1" aria-hidden="true"></a>'
              : "") +
            '<img class="cart-item__image" src="' +
            (item.image || "") +
            '" loading="lazy" alt="" width="72" height="72">' +
            "</div>";
        }
        var title =
          '<div class="cart-drawer-item__right"><div class="cart-drawer-item__details-and-delete-btn"><div class="cart-item__details" role="cell">' +
          '<h4 class="cart-item__name h4 break">' +
          (item.product_title || item.title || "") +
          "</h4>" +
          "</div></div></div>";
        var qtyPrice =
          '<div class="cart-item__totals"><div class="cart-item__price">' +
          (item.final_price ? (item.final_price / 100).toFixed(2) : "") +
          "</div>" +
          '<div class="cart-item__quantity">Qty: ' +
          (item.quantity || 0) +
          "</div></div>";
        li.innerHTML = (media || "") + title + qtyPrice;
        ul.appendChild(li);
      });
      wrapper.appendChild(ul);
      var totals = document.createElement("div");
      totals.className = "cart-drawer__totals";
      var subtotal =
        cart.items_subtotal_price !== undefined
          ? (cart.items_subtotal_price / 100).toFixed(2)
          : cart.total_price !== undefined
          ? (cart.total_price / 100).toFixed(2)
          : "0.00";
      totals.innerHTML =
        '<div class="cart-drawer__totals__row"><span class="cart-drawer__totals__label">Subtotal</span><span class="cart-drawer__totals__money">' +
        subtotal +
        "</span></div>";
      wrapper.appendChild(totals);
      container.innerHTML = "";
      container.appendChild(wrapper);
      var live = document.getElementById("CartDrawer-LiveRegionText");
      if (live) {
        live.textContent = (cart.item_count || 0) + " items in cart";
      }
      // Ensure cart-drawer element state reflects cart emptiness
      try {
        var cartDrawerEl =
          document.querySelector("cart-drawer") ||
          document.getElementById("CartDrawer");
        if (cartDrawerEl) {
          if (cart.item_count && cart.item_count > 0) {
            cartDrawerEl.classList.remove("is-empty");
          } else {
            cartDrawerEl.classList.add("is-empty");
          }
        }
      } catch (e) {}
    } catch (e) {
      try {
        console.error && console.error("renderCartDrawerFromJson error", e);
      } catch (er) {}
    }
  }

  // **OPTIMIZATION 4: Updated Loading Placeholder**
  function showOptimisticDrawerPlaceholder() {
    try {
      var container =
        document.getElementById("CartDrawer-CartItems") ||
        document.getElementById("CartDrawer-Form") ||
        document.getElementById("CartDrawer");
      if (!container) return;
      var existing = container.querySelector(".size-add-optimistic");
      if (existing) return;
      var wrapper = document.createElement("div");
      wrapper.className = "drawer__cart-items-wrapper size-add-optimistic";
      // Animated spinner for better UX
      wrapper.innerHTML =
        '<div style="padding:1.25rem;text-align:center;color:#666">' +
        '<div style="display:inline-block;width:20px;height:20px;border:3px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;"></div>' +
        '<p style="margin-top:0.75rem;font-size:14px;">Adding to cart...</p>' +
        "<style>@keyframes spin{to{transform:rotate(360deg)}}</style>" +
        "</div>";
      if (container.firstChild)
        container.insertBefore(wrapper, container.firstChild);
      else container.appendChild(wrapper);
    } catch (e) {}
  }

  function removeOptimisticPlaceholder() {
    try {
      var ex = document.querySelector(".size-add-optimistic");
      if (ex) ex.remove();
    } catch (e) {}
  }

  function runScriptsInElement(el) {
    try {
      if (!el || !el.querySelectorAll) return;
      var scripts = el.querySelectorAll("script");
      scripts.forEach(function (oldScript) {
        var newScript = document.createElement("script");
        Array.prototype.slice
          .call(oldScript.attributes || [])
          .forEach(function (attr) {
            newScript.setAttribute(attr.name, attr.value);
          });
        newScript.text = oldScript.textContent;
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });
    } catch (e) {
      try {
        console.error && console.error("runScriptsInElement error", e);
      } catch (er) {}
    }
  }

  function loadExternalScriptsFromDoc(doc, timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    try {
      var scripts =
        (doc.querySelectorAll &&
          Array.prototype.slice.call(doc.querySelectorAll("script[src]"))) ||
        [];
      if (!scripts.length) return Promise.resolve(true);
      var promises = scripts.map(function (s) {
        return new Promise(function (resolve) {
          try {
            var src = s.getAttribute("src");
            if (!src) return resolve(true);
            // Avoid duplicate loads when same src exists already in page
            if (document.querySelector('script[src="' + src + '"]'))
              return resolve(true);
            var tag = document.createElement("script");
            tag.src = src;
            tag.async = false;
            tag.defer = false;
            tag.onload = function () {
              resolve(true);
            };
            tag.onerror = function () {
              resolve(false);
            };
            document.head.appendChild(tag);
          } catch (e) {
            resolve(false);
          }
        });
      });
      // Timeout wrapper
      return Promise.race([
        Promise.all(promises),
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve(true);
          }, timeoutMs);
        }),
      ]);
    } catch (e) {
      return Promise.resolve(true);
    }
  }

  function fetchAndInjectDrawerFragment() {
    try {
      var url = window.location.href;
      url +=
        (url.indexOf("?") === -1 ? "?" : "&") +
        "_sizeAddToCart_fragment=" +
        Date.now();
      return fetchWithTimeout(url, { method: "GET" }, 8000)
        .then(function (res) {
          if (!res.ok) return false;
          return res.text();
        })
        .then(function (html) {
          if (!html) return false;
          try {
            var parser = new DOMParser();
            var doc = parser.parseFromString(html, "text/html");
            var frag =
              doc.getElementById("CartDrawer-CartItems") ||
              doc.getElementById("CartDrawer-Form") ||
              doc.getElementById("CartDrawer");
            if (!frag) return false;
            // Prefer copying the full CartDrawer root if the server returned it.
            // Replacing the root preserves server-side classes/attributes and makes
            // sure any data-* attributes that affect visibility/initialization are applied.
            var serverCartRoot =
              doc.getElementById("CartDrawer") ||
              doc.querySelector("cart-drawer");
            var localCartRoot =
              document.getElementById("CartDrawer") ||
              document.querySelector("cart-drawer");
            if (serverCartRoot && localCartRoot && localCartRoot.parentNode) {
              try {
                // If the fragment contains external script tags, load them first.
                return loadExternalScriptsFromDoc(doc, 6000)
                  .then(function () {
                    // Use cloneNode(true) so we don't accidentally move nodes out of the parsed doc
                    var replacement = serverCartRoot.cloneNode(true);
                    localCartRoot.parentNode.replaceChild(
                      replacement,
                      localCartRoot
                    );
                    // Re-select the newly-inserted root and run inline scripts inside it
                    var newLocalRoot =
                      document.getElementById("CartDrawer") ||
                      document.querySelector("cart-drawer");
                    if (newLocalRoot) {
                      try {
                        runScriptsInElement(newLocalRoot);
                      } catch (e) {}
                    }
                    return true;
                  })
                  .catch(function () {
                    // fallback to try replacement even if script loading had errors
                    try {
                      var replacement = serverCartRoot.cloneNode(true);
                      localCartRoot.parentNode.replaceChild(
                        replacement,
                        localCartRoot
                      );
                      var newLocalRoot =
                        document.getElementById("CartDrawer") ||
                        document.querySelector("cart-drawer");
                      if (newLocalRoot) {
                        try {
                          runScriptsInElement(newLocalRoot);
                        } catch (e) {}
                      }
                    } catch (er) {}
                  });
              } catch (e) {
                // Fallback to innerHTML injection if root replacement fails
                var container =
                  document.getElementById("CartDrawer-CartItems") ||
                  document.getElementById("CartDrawer-Form") ||
                  document.getElementById("CartDrawer");
                if (!container) return false;
                container.innerHTML = frag.innerHTML;
                try {
                  runScriptsInElement(container);
                } catch (er) {}
              }
            } else {
              var container =
                document.getElementById("CartDrawer-CartItems") ||
                document.getElementById("CartDrawer-Form") ||
                document.getElementById("CartDrawer");
              if (!container) return false;
              // Load external scripts and then inject cart drawer inner HTML
              return loadExternalScriptsFromDoc(doc, 6000)
                .then(function () {
                  container.innerHTML = frag.innerHTML;
                  try {
                    runScriptsInElement(container);
                  } catch (e) {}
                  return true;
                })
                .catch(function () {
                  container.innerHTML = frag.innerHTML;
                  try {
                    runScriptsInElement(container);
                  } catch (e) {}
                  return true;
                });
            }
            // If the server returned a cart-notification fragment (for header bubble or notification), inject it too
            try {
              var notif = doc.getElementById("cart-notification");
              if (notif) {
                var localNotif = document.getElementById("cart-notification");
                if (localNotif) {
                  localNotif.innerHTML = notif.innerHTML;
                  runScriptsInElement(localNotif);
                }
              }
              var serverBubble = doc.getElementById("cart-icon-bubble");
              if (serverBubble) {
                var localBubble = document.getElementById("cart-icon-bubble");
                if (localBubble) {
                  localBubble.innerHTML = serverBubble.innerHTML;
                }
              }
              // Ensure <cart-drawer> element class matches server fragment
              var serverCartRoot =
                doc.getElementById("CartDrawer") ||
                doc.querySelector("cart-drawer");
              var localCartRoot =
                document.getElementById("CartDrawer") ||
                document.querySelector("cart-drawer");
              if (serverCartRoot && localCartRoot) {
                // copy is-empty class state
                try {
                  if (serverCartRoot.classList.contains("is-empty"))
                    localCartRoot.classList.add("is-empty");
                  else localCartRoot.classList.remove("is-empty");
                } catch (e) {}
              }
            } catch (e) {
              /* non-fatal */
            }
            return true;
          } catch (e) {
            try {
              console.error &&
                console.error("fetchAndInjectDrawerFragment parse error", e);
            } catch (er) {}
            return false;
          }
        })
        .catch(function (err) {
          try {
            console.warn &&
              console.warn(
                "SizeAddToCart: fetchAndInjectDrawerFragment failed",
                err
              );
          } catch (e) {}
          return false;
        });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function dispatchCartUpdated(cart) {
    var evt = new CustomEvent("cart:updated", { detail: { cart: cart } });
    window.dispatchEvent(evt);
    try {
      localStorage.setItem("cart:updated:ts", String(Date.now()));
    } catch (e) {}
  }

  // **OPTIMIZATION 5: Added skipRefresh flag to tryOpenCartDrawer**
  function tryOpenCartDrawer(skipRefresh) {
    // Only refresh if not opening optimistically
    if (!skipRefresh) {
      try {
        if (window.theme && typeof window.theme.refreshCart === "function") {
          window.theme.refreshCart();
        }
        window.dispatchEvent(new CustomEvent("cart:refresh"));
      } catch (e) {}
    }
    if (typeof window[config.cartDrawerOpenFunction] === "function") {
      try {
        window[config.cartDrawerOpenFunction]();
        return;
      } catch (e) {}
    }
    // Best-effort aggressive open: dispatch event, open <details> if present,
    // call .open() on any cart-drawer element, and toggle classes so injected
    // HTML becomes visible without a full page refresh.
    try {
      window.dispatchEvent(new CustomEvent("cart:open"));
    } catch (e) {}
    try {
      // Open details-based drawer if it exists
      var details = document.getElementById("Details-CartDrawer");
      if (details && typeof details.open !== "undefined") {
        try {
          details.open = true;
        } catch (e) {
          details.setAttribute("open", "");
        }
      }
      // Ensure root cart-drawer element shows non-empty state
      var localCartRoot =
        document.querySelector("cart-drawer") ||
        document.getElementById("CartDrawer");
      if (localCartRoot) {
        // If there's a non-empty contents container, remove is-empty
        try {
          var itemsContainer =
            document.getElementById("CartDrawer-CartItems") ||
            document.getElementById("CartDrawer-Form");
          var hasItems =
            itemsContainer &&
            itemsContainer.querySelector &&
            itemsContainer.querySelector(".cart-item");
          if (hasItems) {
            localCartRoot.classList.remove("is-empty");
          } else {
            localCartRoot.classList.add("is-empty");
          }
        } catch (e) {}
        // Call open() if custom element implements it
        try {
          if (typeof localCartRoot.open === "function") {
            localCartRoot.open();
          } else {
            // toggle cosmetic classes to reveal drawer if theme uses them
            localCartRoot.classList.add("active");
            var inner = localCartRoot.querySelector
              ? localCartRoot.querySelector(".drawer__inner")
              : null;
            if (inner) inner.classList.add("active");
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Robust fallback to close the cart drawer. Exposed only inside the IIFE.
  // This prevents ReferenceErrors when overlay clicks attempt to call a missing global helper.
  function closeCartDrawerFallback() {
    try {
      // Preferred: theme helper
      if (window.theme && typeof window.theme.closeCartDrawer === "function") {
        try {
          window.theme.closeCartDrawer();
        } catch (e) {}
        return;
      }
    } catch (e) {}
    try {
      // Other possible global helpers
      if (typeof window.closeCartDrawer === "function") {
        try {
          window.closeCartDrawer();
        } catch (e) {}
        return;
      }
    } catch (e) {}
    try {
      // Signal via event so other code can respond
      try {
        window.dispatchEvent(new CustomEvent("cart:close"));
      } catch (e) {}
    } catch (e) {}
    try {
      // Close details-based drawer if used
      var details = document.getElementById("Details-CartDrawer");
      if (details && typeof details.open !== "undefined") {
        try {
          details.open = false;
        } catch (e) {
          try {
            details.removeAttribute("open");
          } catch (er) {}
        }
      }
    } catch (e) {}
    try {
      // Remove common classes from cart root to hide it
      var root =
        document.querySelector("cart-drawer") ||
        document.getElementById("CartDrawer");
      if (root) {
        try {
          root.classList.remove("active");
        } catch (e) {}
        try {
          root.classList.remove("is-open");
        } catch (e) {}
        try {
          root.classList.remove("open");
        } catch (e) {}
        try {
          root.classList.remove("is-empty");
        } catch (e) {}
      }
    } catch (e) {}
    try {
      // Ensure any body scroll-lock classes are removed so the page becomes scrollable again
      try {
        var body = document.body;
        if (body && body.classList && body.classList.length) {
          var toRemove = [];
          for (var ci = 0; ci < body.classList.length; ci++) {
            var clsName = body.classList[ci];
            if (
              typeof clsName === "string" &&
              clsName.indexOf("overflow-hidden") === 0
            )
              toRemove.push(clsName);
          }
          toRemove.forEach(function (c) {
            try {
              body.classList.remove(c);
            } catch (e) {}
          });
        }
      } catch (e) {}
      try {
        document.documentElement.style.removeProperty("--viewport-height");
      } catch (e) {}
    } catch (e) {}
  }

  // **MEMORY LEAK PREVENTION: Store listener functions as named functions**
  function sizeButtonClickHandler(e) {
    var btn = e.currentTarget || e.target;
    if (!btn.classList || !btn.classList.contains("size-btn")) {
      btn = btn.closest ? btn.closest(config.sizeButtonSelector) : btn;
    }
    if (!btn) return;
    try {
      if (window.SizeAddToCartDebugAlert) {
        var ds =
          btn.getAttribute("data-size") ||
          (btn.dataset &&
            (btn.dataset.size ||
              btn.dataset.variantId ||
              btn.dataset["variant-id"])) ||
          (btn.textContent || "").trim();
        alert("Size button clicked: " + ds);
      }
    } catch (e) {}
    var available = btn.dataset[config.dataAvailableAttr];
    if (
      available === "false" ||
      btn.hasAttribute("disabled") ||
      btn.getAttribute("aria-disabled") === "true"
    )
      return;
    // Update visual selection state immediately when clicked
    try {
      updateSizeButtonSelection(btn);
    } catch (e) {
      try {
        console.error && console.error("Error updating button selection", e);
      } catch (er) {}
    }
    var variantId =
      btn.dataset.variantId ||
      btn.dataset["variant-id"] ||
      btn.getAttribute("data-variant-id");
    var resolvedFrom = "button";
    var productJson = null;
    if (!variantId) {
      productJson = parseProductJson();
      if (productJson) {
        var sizeIndex = -1;
        for (var i = 0; i < (productJson.options || []).length; i++) {
          if (
            (productJson.options[i] || "").toLowerCase().indexOf("size") !== -1
          ) {
            sizeIndex = i;
            break;
          }
        }
        var labelEl = btn.querySelector(config.sizeLabelSelector);
        var labelText = labelEl ? labelEl.textContent : btn.textContent;
        var v = null;
        if (sizeIndex === -1) {
          v = findVariantFromProductJson(productJson, 0, labelText);
        } else {
          v = findVariantFromProductJson(productJson, sizeIndex, labelText);
        }
        if (v && v.id) {
          variantId = v.id;
          resolvedFrom = "productJson";
        }
      }
    }
    if (!variantId) {
      clearInFlightState(btn, null);
      showToast("Unable to find variant for this size.", "error");
      return;
    }
    // Inventory validation before attempting add
    try {
      if (!productJson) productJson = parseProductJson();
      var inventoryCheck = validateInventory(productJson, variantId);
      // Explicitly out of stock - block the add
      if (inventoryCheck.available === false) {
        clearInFlightState(btn, variantId);
        announceToScreenReader(
          inventoryCheck.message || "This size is out of stock."
        );
        showToast(
          inventoryCheck.message || "This size is out of stock.",
          "error"
        );
        return;
      }
      // Low stock warning (non-blocking - still allows add to cart)
      if (inventoryCheck.lowStock && inventoryCheck.message) {
        showToast(inventoryCheck.message, "info");
        announceToScreenReader(inventoryCheck.message);
      }
    } catch (e) {
      try {
        console.error && console.error("Inventory validation error", e);
      } catch (er) {}
    }
    // If another click already started an add for this variant, ignore
    if (pendingVariants[variantId]) {
      announceToScreenReader("Adding item...");
      clearInFlightState(btn, variantId);
      return;
    }
    // Mark this variant as pending and set button state
    pendingVariants[variantId] = true;
    try {
      btn.dataset[config.inFlightAttr] = "1";
    } catch (e) {}
    try {
      btn.classList.add(config.loadingClass);
    } catch (e) {}
    try {
      btn.setAttribute && btn.setAttribute("aria-busy", "true");
    } catch (e) {}
    var attempts = 0;
    function attemptAdd() {
      attempts++;
      // **OPTIMIZATION 1 & 5: Open drawer immediately with loading state (skip theme refresh here)**
      try {
        tryOpenCartDrawer(true);
        showOptimisticDrawerPlaceholder();
      } catch (e) {}
      // **OPTIMIZATION 2: Update cart count optimistically**
      try {
        var cc = $(config.cartCountSelector);
        if (cc) {
          var currentCount =
            parseInt(cc.textContent) ||
            (cachedCart ? cachedCart.item_count : 0);
          cc.textContent = String(currentCount + 1);
          // Update cart icon bubble optimistically
          var iconBubble = document.getElementById("cart-icon-bubble");
          if (iconBubble) {
            var existing = iconBubble.querySelector(".cart-count-bubble");
            if (existing) existing.remove();
            var newCount = currentCount + 1;
            if (newCount > 0) {
              var div = document.createElement("div");
              div.className = "cart-count-bubble";
              if (newCount < 100) {
                var span = document.createElement("span");
                span.setAttribute("aria-hidden", "true");
                span.textContent = String(newCount);
                div.appendChild(span);
              }
              var sr = document.createElement("span");
              sr.className = "visually-hidden";
              sr.textContent =
                window.theme &&
                window.theme.cartStrings &&
                window.theme.cartStrings.count
                  ? window.theme.cartStrings.count
                  : "";
              div.appendChild(sr);
              iconBubble.appendChild(div);
            }
          }
        }
      } catch (e) {}
      return postAddToCart(variantId)
        .then(function (added) {
          // **OPTIMIZATION 3: Run cart JSON fetch and fragment fetch in PARALLEL**
          var cartJsonPromise = fetchCartJson().catch(function () {
            return null;
          });
          var fragmentPromise = fetchAndInjectDrawerFragment().catch(
            function () {
              return false;
            }
          );
          // Wait for both to complete
          return Promise.all([cartJsonPromise, fragmentPromise]).then(function (
            results
          ) {
            var cart = results[0];
            var injected = results[1];
            // Overwrite optimistic cart count with real data
            if (cart && typeof cart.item_count !== "undefined") {
              var cc = $(config.cartCountSelector);
              if (cc) cc.textContent = String(cart.item_count);
              try {
                var iconBubble = document.getElementById("cart-icon-bubble");
                if (iconBubble) {
                  var nonUpsellCount = cart.item_count;
                  var existing = iconBubble.querySelector(".cart-count-bubble");
                  if (existing) existing.remove();
                  if (nonUpsellCount > 0) {
                    var div = document.createElement("div");
                    div.className = "cart-count-bubble";
                    if (nonUpsellCount < 100) {
                      var span = document.createElement("span");
                      span.setAttribute("aria-hidden", "true");
                      span.textContent = String(nonUpsellCount);
                      div.appendChild(span);
                    }
                    var sr = document.createElement("span");
                    sr.className = "visually-hidden";
                    sr.textContent =
                      window.theme &&
                      window.theme.cartStrings &&
                      window.theme.cartStrings.count
                        ? window.theme.cartStrings.count
                        : "";
                    div.appendChild(sr);
                    iconBubble.appendChild(div);
                  }
                }
              } catch (e) {}
            }
            var hidden = $(config.hiddenVariantInputSelector);
            if (hidden) hidden.value = variantId;
            dispatchCartUpdated(cart);
            removeOptimisticPlaceholder();
            // If fragment injection failed, fallback to JSON rendering
            if (!injected && cart) {
              try {
                renderCartDrawerFromJson(cart);
              } catch (e) {}
            }
            // **FIX START: Re-run the open-drawer logic after content injection/replacement**
            if (injected || cart) {
              // Use a small timeout to ensure the browser has fully processed the DOM replacement/injection
              // and the custom element has finished its synchronous initialization before we force it open again.
              setTimeout(function () {
                tryOpenCartDrawer(true); // Re-open the potentially replaced drawer element
              }, 50);
            }
            // **FIX END**
            // Clear in-flight/pending state.
            clearInFlightState(btn, variantId);
            return added;
          });
        })
        .catch(function (err) {
          // **NETWORK RESILIENCE: Exponential Backoff**
          if (attempts <= config.maxRetries) {
            // Calculate delay: base_delay * (2 ^ (attempt_number - 1))
            var delay = config.retryDelayMs * Math.pow(2, attempts - 1);
            return new Promise(function (resolve) {
              setTimeout(resolve, delay);
            }).then(attemptAdd);
          }
          // If attempts exceed maxRetries, handle failure
          clearInFlightState(btn, variantId);
          showToast("Failed to add to cart. Please try again.", "error");
          return Promise.reject(err);
        });
    }
    attemptAdd();
  }

  function sizeButtonKeydownHandler(e) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      e.currentTarget.click(); // Use currentTarget to ensure the correct button is clicked
    }
  }

  function sizeButtonMouseenterHandler() {
    try {
      // Trigger JSON parse early so it's cached for subsequent clicks
      if (!this._productJsonCached) {
        // Use 'this' to reference the button
        parseProductJson();
        this._productJsonCached = true;
      }
    } catch (e) {}
  }

  function documentClickHandler(e) {
    var btn =
      e.target && e.target.closest
        ? e.target.closest(config.sizeButtonSelector)
        : null;
    if (!btn) {
      // Check for overlay click
      var overlay =
        e.target && e.target.closest
          ? e.target.closest("#CartDrawer-Overlay, .cart-drawer__overlay")
          : null;
      if (overlay) {
        setTimeout(function () {
          // Defensive: call a robust fallback close function if available
          try {
            if (typeof closeCartDrawerFallback === "function") {
              closeCartDrawerFallback();
            } else {
              // Best-effort direct close operations if fallback doesn't exist yet
              try {
                if (
                  window.theme &&
                  typeof window.theme.closeCartDrawer === "function"
                ) {
                  window.theme.closeCartDrawer();
                } else if (typeof window.closeCartDrawer === "function") {
                  window.closeCartDrawer();
                } else {
                  // Dispatch event for other listeners
                  try {
                    window.dispatchEvent(new CustomEvent("cart:close"));
                  } catch (e) {}
                  // Close <details> if present
                  try {
                    var d = document.getElementById("Details-CartDrawer");
                    if (d && typeof d.open !== "undefined") d.open = false;
                  } catch (e) {}
                  // Remove active/open classes from cart roots
                  try {
                    var localCartRoot =
                      document.querySelector("cart-drawer") ||
                      document.getElementById("CartDrawer");
                    if (localCartRoot) {
                      localCartRoot.classList.remove("active");
                      localCartRoot.classList.remove("is-open");
                      localCartRoot.classList.remove("open");
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
          } catch (e) {}
        }, 0);
        return; // Exit early if it was an overlay click
      }
      return; // Exit early if it wasn't a size button click
    }
    try {
      sizeButtonClickHandler({ currentTarget: btn, target: btn });
    } catch (err) {
      console.error && console.error(err);
    }
  }

  function documentKeydownHandler(e) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      var btn =
        e.target && e.target.closest
          ? e.target.closest(config.sizeButtonSelector)
          : null;
      if (btn) {
        e.preventDefault();
        try {
          sizeButtonClickHandler({ currentTarget: btn, target: btn });
        } catch (err) {
          console.error && console.error(err);
        }
      }
    }
  }

  function attachHandlers() {
    var buttons = $all(config.sizeButtonSelector);
    if (!buttons || !buttons.length) {
      return;
    }
    var attached = 0;
    buttons.forEach(function (b) {
      // MEMORY LEAK PREVENTION: Check if already attached using the Set
      if (attachedButtonSet.has(b)) {
        return; // Skip if already attached
      }
      attachedButtonSet.add(b);

      // Attach listeners using the stored references
      b.addEventListener("click", boundEventListeners.sizeButtonClick);
      b.addEventListener("keydown", boundEventListeners.sizeButtonKeydown);
      // Use { once: true } for mouseenter to achieve the same effect as the original code
      b.addEventListener(
        "mouseenter",
        boundEventListeners.sizeButtonMouseenter,
        { once: true }
      );

      attached++;
    });
  }

  // **MEMORY LEAK PREVENTION: Create a function to detach handlers from specific buttons**
  function detachHandlersFromButtons(buttons) {
    if (!buttons || !Array.isArray(buttons)) return;
    buttons.forEach(function (b) {
      if (attachedButtonSet.has(b)) {
        b.removeEventListener("click", boundEventListeners.sizeButtonClick);
        b.removeEventListener("keydown", boundEventListeners.sizeButtonKeydown);
        // Note: Mouseenter listener with {once: true} automatically removes itself after firing once.
        // If it was attached multiple times, removeEventListener might not remove it if the same function reference wasn't used.
        // Our {once: true} approach handles this.
        attachedButtonSet.delete(b); // Remove from the tracking set
      }
    });
  }

  // **MEMORY LEAK PREVENTION: Cleanup function to remove all listeners and observers**
  function destroy() {
    // 1. Remove listeners from all previously attached buttons
    var allAttachedButtons = Array.from(attachedButtonSet);
    detachHandlersFromButtons(allAttachedButtons);

    // 2. Remove global document listeners
    if (boundEventListeners.documentClick) {
      document.removeEventListener("click", boundEventListeners.documentClick);
    }
    if (boundEventListeners.documentKeydown) {
      document.removeEventListener(
        "keydown",
        boundEventListeners.documentKeydown
      );
    }
    // The overlay listener is handled within the main document click handler now.

    // 3. Disconnect MutationObserver
    if (mutationObserverInstance) {
      mutationObserverInstance.disconnect();
      mutationObserverInstance = null;
    }

    // 4. Clear the button tracking set
    attachedButtonSet.clear();

    // 5. Clear cached data if necessary (optional)
    cachedCart = null;

    // 6. Clear stored listener references
    for (var key in boundEventListeners) {
      if (boundEventListeners.hasOwnProperty(key)) {
        boundEventListeners[key] = null;
      }
    }
  }

  // Initialize bound listener functions
  boundEventListeners.sizeButtonClick = sizeButtonClickHandler;
  boundEventListeners.sizeButtonKeydown = sizeButtonKeydownHandler;
  boundEventListeners.sizeButtonMouseenter = sizeButtonMouseenterHandler;
  boundEventListeners.documentClick = documentClickHandler;
  boundEventListeners.documentKeydown = documentKeydownHandler;

  // Check Page Load Initialization
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      attachHandlers();
      initializeSizeButtonStates();
    });
  } else {
    attachHandlers();
    initializeSizeButtonStates();
  }

  // Attach global listeners using stored references
  document.addEventListener("click", boundEventListeners.documentClick, {
    passive: false,
  });
  document.addEventListener("keydown", boundEventListeners.documentKeydown);

  // Ensure clicking the overlay/backdrop closes the drawer
  // This logic is now integrated into the main document click handler (documentClickHandler)

  // **MEMORY LEAK PREVENTION: Initialize and store MutationObserver**
  try {
    mutationObserverInstance = new MutationObserver(function (mutations) {
      var found = false;
      mutations.forEach(function (m) {
        if (!m.addedNodes) return;
        for (var i = 0; i < m.addedNodes.length; i++) {
          var n = m.addedNodes[i];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(config.sizeButtonSelector)) {
            found = true;
            break;
          }
          if (n.querySelector && n.querySelector(config.sizeButtonSelector)) {
            found = true;
            break;
          }
        }
      });
      if (found) {
        attachHandlers();
        initializeSizeButtonStates();
      }
    });
    mutationObserverInstance.observe(
      document.documentElement || document.body,
      {
        childList: true,
        subtree: true,
      }
    );
  } catch (e) {
    console.error &&
      console.error("SizeAddToCart: Failed to initialize MutationObserver", e);
  }

  // **MEMORY LEAK PREVENTION: Expose the destroy function globally**
  global.SizeAddToCart = {
    init: attachHandlers,
    destroy: destroy, // Expose the cleanup function
  };

  // Optional: Auto-cleanup on page unload (useful if script is re-injected)
  // window.addEventListener('beforeunload', destroy);
})(window || globalThis);
