class CartNotification extends HTMLElement {
  constructor() {
    super();
    // Run initial setup
    this.onBodyClick = this.handleBodyClick.bind(this);
    this.initNotification();
  }

  initNotification() {
    // Re-query notification and header in case DOM was re-injected
    this.notification = document.getElementById("cart-notification");
    this.header = document.querySelector("sticky-header");

    if (!this.notification) return;

    // Remove previous listeners (defensive) then re-add
    try {
      this.notification.removeEventListener("keyup", this._boundKeyup);
    } catch (e) {}
    try {
      this.querySelectorAll('button[type="button"]').forEach((closeButton) => {
        try {
          closeButton.removeEventListener("click", this._boundClose);
        } catch (e) {}
      });
    } catch (e) {}

    // Bind handlers and store bound references for potential removal
    this._boundKeyup = (evt) => evt.code === "Escape" && this.close();
    this._boundClose = this.close.bind(this);

    this.notification.addEventListener("keyup", this._boundKeyup);
    this.querySelectorAll('button[type="button"]').forEach((closeButton) =>
      closeButton.addEventListener("click", this._boundClose)
    );
  }

  open() {
    this.notification.classList.add("animate", "active");

    this.notification.addEventListener(
      "transitionend",
      () => {
        this.notification.focus();
        trapFocus(this.notification);
      },
      { once: true }
    );

    document.body.addEventListener("click", this.onBodyClick);
  }

  close() {
    this.notification.classList.remove("active");
    document.body.removeEventListener("click", this.onBodyClick);

    removeTrapFocus(this.activeElement);
  }

  renderContents(parsedState, dontOpen = false) {
    this.cartItemKey = parsedState.key;
    this.getSectionsToRender().forEach((section) => {
      document.getElementById(section.id).innerHTML = this.getSectionInnerHTML(
        parsedState.sections[section.id],
        section.selector
      );
    });

    if (this.header) this.header.reveal();
    this.open();
  }

  getSectionsToRender() {
    return [
      {
        id: "cart-notification-product",
        selector: `[id="cart-notification-product-${this.cartItemKey}"]`,
      },
      {
        id: "cart-notification-button",
      },
      {
        id: "cart-icon-bubble",
      },
    ];
  }

  getSectionInnerHTML(html, selector = ".shopify-section") {
    return new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector(selector).innerHTML;
  }

  handleBodyClick(evt) {
    const target = evt.target;
    if (target !== this.notification && !target.closest("cart-notification")) {
      const disclosure = target.closest("details-disclosure, header-menu");
      this.activeElement = disclosure
        ? disclosure.querySelector("summary")
        : null;
      this.close();
    }
  }

  setActiveElement(element) {
    this.activeElement = element;
  }
}

customElements.define("cart-notification", CartNotification);

// When the drawer HTML is injected dynamically, notify cart-notification to
// re-initialize its internals. We dispatch the event from size-add-to-cart.js
// after injection; listen here and call the component's init method.
try {
  window.addEventListener("cart:drawer:updated", function () {
    var el = document.querySelector("cart-notification");
    if (el && typeof el.initNotification === "function") {
      try {
        el.initNotification();
      } catch (e) {}
    }
  });
} catch (e) {}
