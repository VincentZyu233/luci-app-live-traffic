include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-live-traffic
PKG_VERSION:=0.2.2-beta.3
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=VincentZyu233

LUCI_TITLE:=LuCI realtime per-client traffic monitor
LUCI_DEPENDS:=+luci-base +nlbwmon +rpcd-mod-ucode
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/live_traffic
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
