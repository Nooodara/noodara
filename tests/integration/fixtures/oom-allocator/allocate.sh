#!/bin/sh
# Doubles one 1 MiB string up to 512 MiB. Under --memory=32m the kernel kills it (exit 137);
# without a limit it stops at 512 MiB and exits 0, so a missing cgroup fails the test, not the host.
echo NOODARA_OOM_ALLOCATING
data=$(head -c 1048576 /dev/zero | tr '\0' x)
i=0
while [ "$i" -lt 9 ]; do
  data="$data$data"
  i=$((i + 1))
done
echo "NOODARA_OOM_SURVIVED ${#data}"
