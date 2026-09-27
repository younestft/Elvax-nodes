import nodes


class LoadCropImage(nodes.LoadImage):
    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        inputs["required"].update({
            "crop_x": ("INT", {"default": 0, "min": 0}),
            "crop_y": ("INT", {"default": 0, "min": 0}),
            "crop_width": ("INT", {"default": 0, "min": 0}),
            "crop_height": ("INT", {"default": 0, "min": 0}),
        })
        return inputs

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load_crop_image"
    CATEGORY = "Elvax/image"
    SEARCH_ALIASES = ["load crop image", "crop image loader", "upload and crop image"]

    def load_crop_image(self, image, crop_x=0, crop_y=0, crop_width=0, crop_height=0):
        images, mask = super().load_image(image)
        if crop_width <= 0 or crop_height <= 0:
            return images, mask

        height, width = images.shape[1:3]
        left = max(0, min(int(crop_x), width - 1))
        top = max(0, min(int(crop_y), height - 1))
        right = min(width, left + max(1, int(crop_width)))
        bottom = min(height, top + max(1, int(crop_height)))
        images = images[:, top:bottom, left:right, :].contiguous()

        if mask.shape[-2:] == (height, width):
            mask = mask[..., top:bottom, left:right].contiguous()
        else:
            mask = mask.new_zeros((images.shape[0], images.shape[1], images.shape[2]))

        return images, mask

    @classmethod
    def IS_CHANGED(cls, image, crop_x=0, crop_y=0, crop_width=0, crop_height=0):
        return (
            super().IS_CHANGED(image),
            int(crop_x),
            int(crop_y),
            int(crop_width),
            int(crop_height),
        )
