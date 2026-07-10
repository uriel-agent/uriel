{
  disko.devices.disk.main = {
    type = "disk";
    # Cloud VPS = /dev/sda, auction/dedicated NVMe = /dev/nvme0n1. Adjust
    # before deploy.
    device = "/dev/sda";
    content = {
      type = "gpt";
      partitions = {
        boot = {
          size = "1M";
          # BIOS boot partition; Hetzner cloud images and dedicated servers
          # both boot from it.
          type = "EF02";
        };
        esp = {
          size = "512M";
          type = "EF00";
          content = {
            type = "filesystem";
            format = "vfat";
            mountpoint = "/boot";
          };
        };
        root = {
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
      };
    };
  };
}
