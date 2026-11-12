#!/bin/sh
# Network namespace for a shaped soak player: a veth pair to the host, NAT out.
# impair.mjs shapes veth-host (down) and veth-ns (up). Usage (root): netns.sh NAME
set -eu
ns=${1:-soak}
ip netns add "$ns"
ip link add veth-host type veth peer name veth-ns
ip link set veth-ns netns "$ns"
ip addr add 10.200.0.1/24 dev veth-host
ip link set veth-host up
ip netns exec "$ns" ip link set lo up
ip netns exec "$ns" ip addr add 10.200.0.2/24 dev veth-ns
ip netns exec "$ns" ip link set veth-ns up
ip netns exec "$ns" ip route add default via 10.200.0.1
sysctl -qw net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 10.200.0.0/24 -j MASQUERADE
iptables -I FORWARD -i veth-host -j ACCEPT
iptables -I FORWARD -o veth-host -j ACCEPT
# The host resolver (127.0.0.53) is not reachable from the namespace.
mkdir -p "/etc/netns/$ns"
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "/etc/netns/$ns/resolv.conf"
