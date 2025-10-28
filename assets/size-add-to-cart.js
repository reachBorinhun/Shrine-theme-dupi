/*
  size-add-to-cart.js - FIXED: Drawer opens AFTER item is rendered
  - FIX: Moved tryOpenCartDrawer() call to AFTER renderOptimisticCartItem()
  - This ensures the drawer only opens once the product is visible inside it
  - Eliminates the "empty drawer flash" UX issue
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
  };
  var mutationObserverInstance = null;
  var attachedButtonSet = new Set();

  var cachedProductJson = null;
  var lastSelectedMap =
    typeof WeakMap !== "undefined" ? new WeakMap() : new Map();
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
    retryDelayMs: 600,
    maxRetries: 2,
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
    if (cachedProductJson) return cachedProductJson;
    var el = $(config.productJsonSelector);
    if (el) {
      try {
        cachedProductJson = JSON.parse(el.textContent);
        return cachedProductJson;
      } catch (e) {
        return null;
      }
    }
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.id && s.id.indexOf(config.productJsonIdPrefix) === 0) {
        try {
          cachedProductJson = JSON.parse(s.textContent);
          return cachedProductJson;
        } catch (e) {}
      }
    }
    return null;
  }

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
          btn.style.removeProperty("text-decoration");
        } catch (e) {}

        try {
          if (btn.dataset && btn.dataset.originalLabel) {
            try {
              var lbl = getLabelElement(btn);
              if (lbl) {
                lbl.textContent = btn.dataset.originalLabel;
                try {
                  lbl.style.removeProperty("text-decoration");
                } catch (e) {}
              }
            } catch (er) {}
            try {
              delete btn.dataset.originalLabel;
            } catch (er) {}
          }
        } catch (e) {}

        try {
          if (btn.querySelector) {
            var sp = btn.querySelector(".btn-spinner, .size-btn-spinner");
            if (sp && sp.remove) sp.remove();
          }
        } catch (e) {}

        try {
          if (
            btn.dataset &&
            typeof btn.dataset.originalDisabled !== "undefined"
          ) {
            var orig = btn.dataset.originalDisabled === "true";
            try {
              if (!orig) {
                try {
                  btn.removeAttribute("disabled");
                } catch (e) {}
                try {
                  btn.removeAttribute("aria-disabled");
                } catch (e) {}
              } else {
                try {
                  btn.setAttribute("disabled", "");
                } catch (e) {}
                try {
                  btn.setAttribute("aria-disabled", "true");
                } catch (e) {}
              }
            } catch (er) {}
            try {
              delete btn.dataset.originalDisabled;
            } catch (er) {}
          }
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

  function validateInventory(productJson, variantId) {
    try {
      if (!productJson || !productJson.variants) {
        return {
          available: null,
          reason: "unknown",
          message: null,
          lowStock: false,
        };
      }
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
      if (!variant) {
        return {
          available: false,
          reason: "variant_not_found",
          message: "This size is not available.",
          lowStock: false,
        };
      }
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
      if (variant.inventory_management) {
        if (typeof variant.inventory_quantity !== "undefined") {
          var qty = variant.inventory_quantity;
          if (variant.inventory_policy === "deny" && qty <= 0) {
            return {
              available: false,
              reason: "out_of_stock",
              message: "This size is currently out of stock.",
              lowStock: false,
            };
          }
          if (qty > 0 && qty <= 3) {
            return {
              available: true,
              reason: "low_stock",
              message: "Only " + qty + " left in stock!",
              lowStock: true,
              quantity: qty,
            };
          }
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

  function announceToScreenReader(message) {
    try {
      var live = createAriaLive();
      if (!live) return;
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

  function updateSizeButtonSelection(selectedButton) {
    try {
      if (!selectedButton) return;
      var container = selectedButton.closest(
        ".size-buttons-grid, .card-size-swatches, .size-selector-container"
      );
      if (!container) {
        container = selectedButton.closest(
          "form, [data-product-form], .product, .card"
        );
      }
      if (!container) {
        container =
          selectedButton.closest('[class*="product"]') ||
          selectedButton.closest('[id*="product"]') ||
          selectedButton.closest('[id*="Product"]');
      }
      if (!container) {
        var parent = selectedButton.parentElement;
        if (parent) {
          container = parent;
        } else {
          try {
            selectedButton.setAttribute("aria-pressed", "true");
            selectedButton.setAttribute("data-selected", "true");
            selectedButton.classList.add("is-selected");
          } catch (e) {}
          return;
        }
      }
      try {
        var prev = lastSelectedMap.get(container);
        if (prev && prev !== selectedButton) {
          try {
            prev.setAttribute("aria-pressed", "false");
            prev.removeAttribute("data-selected");
            prev.classList.remove("is-selected");
            var prevLabel =
              prev.getAttribute("aria-label") || prev.textContent || "";
            if (prevLabel) {
              prevLabel = prevLabel.replace(/,?\s*selected$/i, "").trim();
              if (prev.hasAttribute("aria-label"))
                prev.setAttribute("aria-label", prevLabel);
            }
          } catch (e) {}
        } else if (!prev) {
          try {
            var existingSelected = container.querySelector(
              '.is-selected, [data-selected="true"], [aria-pressed="true"]'
            );
            if (existingSelected && existingSelected !== selectedButton) {
              try {
                existingSelected.setAttribute("aria-pressed", "false");
                existingSelected.removeAttribute("data-selected");
                existingSelected.classList.remove("is-selected");
                var exLabel =
                  existingSelected.getAttribute("aria-label") ||
                  existingSelected.textContent ||
                  "";
                if (exLabel) {
                  exLabel = exLabel.replace(/,?\s*selected$/i, "").trim();
                  if (existingSelected.hasAttribute("aria-label"))
                    existingSelected.setAttribute("aria-label", exLabel);
                }
              } catch (e) {}
            }
          } catch (e) {}
        }

        try {
          selectedButton.setAttribute("aria-pressed", "true");
          selectedButton.setAttribute("data-selected", "true");
          selectedButton.classList.add("is-selected");
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
          try {
            lastSelectedMap.set(container, selectedButton);
          } catch (e) {}
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
    } catch (e) {
      try {
        console.error && console.error("updateSizeButtonSelection error", e);
      } catch (er) {}
    }
  }

  function initializeSizeButtonStates() {
    try {
      var containers = document.querySelectorAll(
        ".size-buttons-grid, .card-size-swatches, .size-selector-container"
      );
      for (var i = 0; i < containers.length; i++) {
        var container = containers[i];
        var preSelected = container.querySelector(
          '.size-btn[aria-pressed="true"], .size-btn[data-selected="true"], .size-btn.is-selected, ' +
            '.variant-swatch[aria-pressed="true"], .variant-swatch[data-selected="true"], .variant-swatch.is-selected'
        );
        if (preSelected) {
          updateSizeButtonSelection(preSelected);
        } else {
          var form = container.closest("form, [data-product-form]");
          if (form) {
            var hiddenInput = form.querySelector('input[name="id"]');
            if (hiddenInput && hiddenInput.value) {
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
        cachedCart = cart;
        return cart;
      });
  }

  function renderOptimisticCartItem(item) {
    try {
      if (!item) return;

      var container =
        document.getElementById("CartDrawer-CartItems") ||
        document.getElementById("CartDrawer-Form");

      var placeholder = document.querySelector(".size-add-optimistic");
      if (!container || !placeholder) {
        return;
      }

      var itemsList = container.querySelector(".cart-items.list-unstyled");
      var isFirstItem = !itemsList;

      if (isFirstItem) {
        var wrapper = container.querySelector(".drawer__cart-items-wrapper");
        if (wrapper) wrapper.remove();

        wrapper = document.createElement("div");
        wrapper.className = "drawer__cart-items-wrapper";

        itemsList = document.createElement("ul");
        itemsList.className = "cart-items list-unstyled";

        wrapper.appendChild(itemsList);

        var totals = document.createElement("div");
        totals.className = "cart-drawer__totals";
        totals.id = "CartDrawer-Totals";
        wrapper.appendChild(totals);

        container.innerHTML = "";
        container.appendChild(wrapper);
      } else {
        placeholder.remove();
      }

      var li = document.createElement("li");
      li.className =
        "cart-drawer-item cart-item cart-item--optimistic cart-item--product-" +
        (item.handle || "");
      li.setAttribute("role", "row");
      li.setAttribute("data-id", String(item.id || "temp"));

      var price = (item.final_price || item.price) / 100;
      var currency = item.final_price_formatted
        ? item.final_price_formatted.replace(/[\d\.\,]/g, "").trim()
        : "";

      var imageSrc =
        (item.featured_image && item.featured_image.url) || item.image || "";
      if (
        imageSrc &&
        imageSrc.indexOf("http") === -1 &&
        imageSrc.indexOf("//") !== -1
      ) {
        imageSrc = "https:" + imageSrc;
      }

      var html =
        '<div class="cart-item__media" role="cell">' +
        (item.url
          ? '<a href="' +
            (item.url || "#") +
            '" class="cart-item__link" tabindex="-1" aria-hidden="true"></a>'
          : "") +
        '<img class="cart-item__image" src="' +
        (imageSrc || "") +
        '" loading="lazy" alt="" width="72" height="72">' +
        "</div>" +
        '<div class="cart-drawer-item__right">' +
        '<div class="cart-drawer-item__details-and-delete-btn">' +
        '<div class="cart-item__details" role="cell">' +
        '<h4 class="cart-item__name h4 break">' +
        (item.product_title || item.title || "") +
        "</h4>" +
        (item.variant_title
          ? '<div class="cart-item__variant-title">' +
            item.variant_title +
            "</div>"
          : "") +
        "</div>" +
        "</div>" +
        '<div class="cart-item__totals">' +
        '<div class="cart-item__price">' +
        currency +
        price.toFixed(2) +
        "</div>" +
        '<div class="cart-item__quantity">Qty: ' +
        (item.quantity || 1) +
        "</div>" +
        "</div>" +
        "</div>";

      li.innerHTML = html;

      if (itemsList.firstChild) {
        itemsList.insertBefore(li, itemsList.firstChild);
      } else {
        itemsList.appendChild(li);
      }

      var subtotalEl = container.querySelector(
        "#CartDrawer-Totals .cart-drawer__totals__money"
      );
      if (subtotalEl) {
        try {
          if (
            cachedCart &&
            typeof cachedCart.items_subtotal_price === "number"
          ) {
            var newTotal = cachedCart.items_subtotal_price;
            subtotalEl.textContent = currency + (newTotal / 100).toFixed(2);
          }
        } catch (e) {}
      }

      var live = document.getElementById("CartDrawer-LiveRegionText");
      if (live) {
        var currentCount =
          parseInt(live.textContent) ||
          (cachedCart ? cachedCart.item_count : 0);
        live.textContent = currentCount + 1 + " items in cart";
      }
    } catch (e) {
      console.error("renderOptimisticCartItem error", e);
    }
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
      var itemsFragment = document.createDocumentFragment();
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
          (item.variant_title
            ? '<div class="cart-item__variant-title">' +
              item.variant_title +
              "</div>"
            : "") +
          "</div></div></div>";
        var qtyPrice =
          '<div class="cart-item__totals"><div class="cart-item__price">' +
          (item.final_price ? (item.final_price / 100).toFixed(2) : "") +
          "</div>" +
          '<div class="cart-item__quantity">Qty: ' +
          (item.quantity || 0) +
          "</div></div>";
        li.innerHTML = (media || "") + title + qtyPrice;
        itemsFragment.appendChild(li);
      });
      ul.appendChild(itemsFragment);
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
      wrapper.innerHTML =
        '<div style="padding:1.25rem;text-align:center;color:#666">' +
        '<div style="display:inline-block;width:20px;height:20px;border:3px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;"></div>' +
        '<p style="margin-top:0.75rem;font-size:14px;">Adding to cart...</p>' +
        "<style>@keyframes spin{to{transform:rotate(360deg)}}</style>" +
        "</div>";
      var itemsList = container.querySelector(".cart-items.list-unstyled");
      var isTrulyEmpty = !itemsList || itemsList.children.length === 0;

      if (isTrulyEmpty) {
        container.innerHTML = "";
        container.appendChild(wrapper);
      } else if (itemsList) {
        itemsList.insertAdjacentElement("beforebegin", wrapper);
      } else {
        if (container.firstChild)
          container.insertBefore(wrapper, container.firstChild);
        else container.appendChild(wrapper);
      }
    } catch (e) {}
  }

  function removeOptimisticPlaceholder() {
    try {
      var ex = document.querySelector(".size-add-optimistic");
      if (ex) ex.remove();
    } catch (e) {}
  }

  function getLabelElement(btn) {
    try {
      if (!btn) return null;
      if (btn.querySelector) {
        var el = btn.querySelector(config.sizeLabelSelector);
        if (el) return el;
        el = btn.querySelector("span");
        return el || null;
      }
    } catch (e) {}
    return null;
  }

  function setButtonLoadingState(btn) {
    try {
      if (!btn) return;

      try {
        if (btn.querySelector) {
          var sp = btn.querySelector(".btn-spinner, .size-btn-spinner");
          if (sp && sp.remove) sp.remove();
        }
      } catch (e) {}

      var lbl = getLabelElement(btn);
      try {
        if (lbl && typeof lbl.textContent !== "undefined") {
          try {
            btn.dataset.originalLabel = lbl.textContent;
          } catch (e) {}
          var loadingText =
            (window.theme &&
              window.theme.cartStrings &&
              window.theme.cartStrings.adding) ||
            (window.theme && window.theme.addingToCartText) ||
            "Adding\u2026";
          try {
            lbl.textContent = loadingText;
          } catch (e) {}

          try {
            lbl.style.setProperty("text-decoration", "none", "important");
          } catch (e) {}
        }
      } catch (e) {}

      try {
        btn.style.setProperty("text-decoration", "none", "important");
      } catch (e) {}

      try {
        var origDisabled =
          (btn.hasAttribute && btn.hasAttribute("disabled")) ||
          (btn.getAttribute && btn.getAttribute("aria-disabled") === "true");
        try {
          btn.dataset.originalDisabled = origDisabled ? "true" : "false";
        } catch (e) {}
        try {
          btn.setAttribute("disabled", "");
        } catch (e) {}
        try {
          btn.setAttribute("aria-disabled", "true");
        } catch (e) {}
      } catch (e) {}

      try {
        btn.classList.add(config.loadingClass);
      } catch (e) {}
      try {
        btn.setAttribute && btn.setAttribute("aria-busy", "true");
      } catch (e) {}

      try {
        var ann =
          (window.theme &&
            window.theme.cartStrings &&
            window.theme.cartStrings.adding) ||
          (window.theme && window.theme.addingToCartText) ||
          "Adding\u2026";
        announceToScreenReader(ann);
      } catch (e) {}
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
            var serverCartRoot =
              doc.getElementById("CartDrawer") ||
              doc.querySelector("cart-drawer");
            var localCartRoot =
              document.getElementById("CartDrawer") ||
              document.querySelector("cart-drawer");
            if (serverCartRoot && localCartRoot && localCartRoot.parentNode) {
              try {
                var replacement = serverCartRoot.cloneNode(true);
                localCartRoot.parentNode.replaceChild(
                  replacement,
                  localCartRoot
                );

                try {
                  window.dispatchEvent(
                    new CustomEvent("cart:drawer:updated", {
                      detail: {
                        source: "size-add-to-cart",
                        method: "fragment",
                      },
                    })
                  );
                } catch (e) {}

                return true;
              } catch (e) {}
            } else {
              var container =
                document.getElementById("CartDrawer-CartItems") ||
                document.getElementById("CartDrawer-Form") ||
                document.getElementById("CartDrawer");
              if (!container) return false;
              try {
                container.innerHTML = frag.innerHTML;
              } catch (e) {
                try {
                  container.innerHTML = frag.innerHTML;
                } catch (er) {}
              }

              try {
                window.dispatchEvent(
                  new CustomEvent("cart:drawer:updated", {
                    detail: { source: "size-add-to-cart", method: "innerHTML" },
                  })
                );
              } catch (e) {}

              return true;
            }
            try {
              var notif = doc.getElementById("cart-notification");
              if (notif) {
                var localNotif = document.getElementById("cart-notification");
                if (localNotif) {
                  try {
                    localNotif.innerHTML = notif.innerHTML;
                  } catch (e) {}
                }
                try {
                  window.dispatchEvent(
                    new CustomEvent("cart:drawer:updated", {
                      detail: {
                        source: "size-add-to-cart",
                        fragmentIncludesNotification: true,
                      },
                    })
                  );
                } catch (e) {}
              }
              var serverCartRoot =
                doc.getElementById("CartDrawer") ||
                doc.querySelector("cart-drawer");
              var localCartRoot =
                document.getElementById("CartDrawer") ||
                document.querySelector("cart-drawer");
              if (serverCartRoot && localCartRoot) {
                try {
                  if (serverCartRoot.classList.contains("is-empty"))
                    localCartRoot.classList.add("is-empty");
                  else localCartRoot.classList.remove("is-empty");
                } catch (e) {}
              }
            } catch (e) {}
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
      if (cart && typeof cart.item_count !== "undefined") {
        try {
          localStorage.setItem("cart:item_count", String(cart.item_count));
        } catch (e) {}
      }
    } catch (e) {}
  }

  function tryOpenCartDrawer(skipRefresh) {
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
    try {
      window.dispatchEvent(new CustomEvent("cart:open"));
    } catch (e) {}
    try {
      var details = document.getElementById("Details-CartDrawer");
      if (details && typeof details.open !== "undefined") {
        try {
          details.open = true;
        } catch (e) {
          details.setAttribute("open", "");
        }
      }
      var localCartRoot =
        document.querySelector("cart-drawer") ||
        document.getElementById("CartDrawer");
      if (localCartRoot) {
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
        try {
          if (typeof localCartRoot.open === "function") {
            localCartRoot.open();
          } else {
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

  function closeCartDrawerFallback() {
    try {
      if (window.theme && typeof window.theme.closeCartDrawer === "function") {
        try {
          window.theme.closeCartDrawer();
        } catch (e) {}
        return;
      }
    } catch (e) {}
    try {
      if (typeof window.closeCartDrawer === "function") {
        try {
          window.closeCartDrawer();
        } catch (e) {}
        return;
      }
    } catch (e) {}
    try {
      try {
        window.dispatchEvent(new CustomEvent("cart:close"));
      } catch (e) {}
    } catch (e) {}
    try {
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
        }
      }
    }
    if (!variantId) {
      clearInFlightState(btn, null);
      showToast("Unable to find variant for this size.", "error");
      return;
    }
    try {
      if (!productJson) productJson = parseProductJson();
      var inventoryCheck = validateInventory(productJson, variantId);
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
      if (inventoryCheck.lowStock && inventoryCheck.message) {
        showToast(inventoryCheck.message, "info");
        announceToScreenReader(inventoryCheck.message);
      }
    } catch (e) {
      try {
        console.error && console.error("Inventory validation error", e);
      } catch (er) {}
    }
    if (pendingVariants[variantId]) {
      announceToScreenReader("Adding item...");
      clearInFlightState(btn, variantId);
      return;
    }
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
    try {
      try {
        setButtonLoadingState(btn);
      } catch (e) {}
    } catch (e) {}
    var attempts = 0;
    function attemptAdd() {
      attempts++;

      try {
        var cc = $(config.cartCountSelector);
        var currentCount =
          cachedCart && typeof cachedCart.item_count === "number"
            ? cachedCart.item_count
            : cc
            ? parseInt(cc.textContent, 10) || 0
            : 0;
        var newCount = currentCount + 1;

        cachedCart = cachedCart || {};
        cachedCart.item_count = newCount;
        try {
          localStorage.setItem(
            "cart:item_count",
            String(cachedCart.item_count)
          );
        } catch (e) {}
      } catch (e) {}

      return postAddToCart(variantId)
        .then(function (added) {
          // Render optimistic item and remove placeholder. Do NOT open the drawer here.
          // The drawer will open later after fragment/cart.json hydration (see the delayed tryOpenCartDrawer below).
          removeOptimisticPlaceholder();
          renderOptimisticCartItem(added);

          var fragmentPromise = fetchAndInjectDrawerFragment().catch(
            function () {
              return false;
            }
          );

          var cartJsonPromise = fetchCartJson().catch(function () {
            return null;
          });

          return Promise.all([fragmentPromise, cartJsonPromise]).then(function (
            results
          ) {
            var injected = results[0];
            var cart = results[1];

            if (cart && typeof cart.item_count !== "undefined") {
              var ccAfter = $(config.cartCountSelector);
              if (ccAfter) ccAfter.textContent = String(cart.item_count);
              cachedCart = cart;

              try {
                var iconBubbleAfter =
                  document.getElementById("cart-icon-bubble");
                if (iconBubbleAfter) {
                  var existingAfter =
                    iconBubbleAfter.querySelector(".cart-count-bubble");
                  if (existingAfter) existingAfter.remove();
                  var newCountAfter = cart.item_count;
                  if (newCountAfter > 0) {
                    var divAfter = document.createElement("div");
                    divAfter.className = "cart-count-bubble";
                    if (newCountAfter < 100) {
                      var spanAfter = document.createElement("span");
                      spanAfter.setAttribute("aria-hidden", "true");
                      spanAfter.textContent = String(newCountAfter);
                      divAfter.appendChild(spanAfter);
                    }
                    var srAfter = document.createElement("span");
                    srAfter.className = "visually-hidden";
                    srAfter.textContent =
                      window.theme &&
                      window.theme.cartStrings &&
                      window.theme.cartStrings.count
                        ? window.theme.cartStrings.count
                        : "";
                    divAfter.appendChild(srAfter);
                    iconBubbleAfter.appendChild(divAfter);
                  }
                }
              } catch (e) {}
            }

            var hidden = $(config.hiddenVariantInputSelector);
            if (hidden) hidden.value = variantId;

            dispatchCartUpdated(cart || { item_count: cachedCart.item_count });

            if (injected || cart) {
              setTimeout(function () {
                tryOpenCartDrawer(true);
              }, 50);
            }

            clearInFlightState(btn, variantId);
            return added;
          });
        })
        .catch(function (err) {
          if (attempts <= config.maxRetries) {
            var delay = config.retryDelayMs * Math.pow(2, attempts - 1);
            return new Promise(function (resolve) {
              setTimeout(resolve, delay);
            }).then(attemptAdd);
          }
          clearInFlightState(btn, variantId);
          showToast("Failed to add to cart. Please try again.", "error");
          try {
            var cc = $(config.cartCountSelector);
            if (cc)
              cc.textContent = String((parseInt(cc.textContent, 10) || 1) - 1);
            if (cachedCart)
              cachedCart.item_count = (cachedCart.item_count || 1) - 1;
          } catch (e) {}
          removeOptimisticPlaceholder();
          return Promise.reject(err);
        });
    }
    attemptAdd();
  }

  function sizeButtonKeydownHandler(e) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      e.currentTarget.click();
    }
  }

  function sizeButtonMouseenterHandler() {
    try {
      if (!this._productJsonCached) {
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
      var overlay =
        e.target && e.target.closest
          ? e.target.closest("#CartDrawer-Overlay, .cart-drawer__overlay")
          : null;
      if (overlay) {
        setTimeout(function () {
          try {
            if (typeof closeCartDrawerFallback === "function") {
              closeCartDrawerFallback();
            }
          } catch (e) {}
        }, 0);
        return;
      }
      return;
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
      if (attachedButtonSet.has(b)) {
        return;
      }
      attachedButtonSet.add(b);

      b.addEventListener("click", boundEventListeners.sizeButtonClick);
      b.addEventListener("keydown", boundEventListeners.sizeButtonKeydown);
      b.addEventListener(
        "mouseenter",
        boundEventListeners.sizeButtonMouseenter,
        { once: true }
      );

      attached++;
    });
  }

  function detachHandlersFromButtons(buttons) {
    if (!buttons || !Array.isArray(buttons)) return;
    buttons.forEach(function (b) {
      if (attachedButtonSet.has(b)) {
        b.removeEventListener("click", boundEventListeners.sizeButtonClick);
        b.removeEventListener("keydown", boundEventListeners.sizeButtonKeydown);
        attachedButtonSet.delete(b);
      }
    });
  }

  function destroy() {
    var allAttachedButtons = Array.from(attachedButtonSet);
    detachHandlersFromButtons(allAttachedButtons);

    if (boundEventListeners.documentClick) {
      document.removeEventListener("click", boundEventListeners.documentClick);
    }
    if (boundEventListeners.documentKeydown) {
      document.removeEventListener(
        "keydown",
        boundEventListeners.documentKeydown
      );
    }

    if (mutationObserverInstance) {
      mutationObserverInstance.disconnect();
      mutationObserverInstance = null;
    }

    attachedButtonSet.clear();
    cachedCart = null;

    for (var key in boundEventListeners) {
      if (boundEventListeners.hasOwnProperty(key)) {
        boundEventListeners[key] = null;
      }
    }
  }

  boundEventListeners.sizeButtonClick = sizeButtonClickHandler;
  boundEventListeners.sizeButtonKeydown = sizeButtonKeydownHandler;
  boundEventListeners.sizeButtonMouseenter = sizeButtonMouseenterHandler;
  boundEventListeners.documentClick = documentClickHandler;
  boundEventListeners.documentKeydown = documentKeydownHandler;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      attachHandlers();
      initializeSizeButtonStates();
      try {
        parseProductJson();
      } catch (e) {}
    });
  } else {
    attachHandlers();
    initializeSizeButtonStates();
    try {
      parseProductJson();
    } catch (e) {}
  }

  document.addEventListener("click", boundEventListeners.documentClick, {
    passive: false,
  });
  document.addEventListener("keydown", boundEventListeners.documentKeydown);

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

  global.SizeAddToCart = {
    init: attachHandlers,
    destroy: destroy,
  };
})(window || globalThis);
